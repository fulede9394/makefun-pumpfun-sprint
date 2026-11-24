// Pump.fun paper-trading bot: ride mature curves whose tape is accelerating.
//
// A curve earns a buy when it is old enough that the bundled-launch dump is behind it and
// its recent prints show fresh money piling in: net SOL flowing in, a handful of distinct
// buyers, the price up and hugging its window high, and the second half of the window pulling
// in more than the first. One fixed-size buy per position, never averaged down: losers are
// cut by a stop, winners are trailed, and anything that goes quiet is closed by a time cap.
//
// Tiny probe round trips keep the run above the guardrail floor (a filled round trip of at
// least 0.01 SOL on 20+ coins): when the bot's own fills or coins fall behind the pace the
// block clock implies, it buys a sliver of a liquid curve and dumps it the moment the buy
// lands.
//
// Nothing here reads a clock or rolls dice: every decision is a pure function of the batch
// stream, and every map is walked in insertion order, so a replay reproduces exactly.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Config {
  /** Lookback in slots for the entry tape scan. */
  span: number;
  /** Net SOL (buys minus sells) the window must show. */
  minFlow: number;
  /** Trades inside the window, minimum. */
  minPrints: number;
  /** Distinct buying wallets inside the window, minimum. */
  minWallets: number;
  /** Price now versus price at the window start, minus 1, minimum. */
  minRise: number;
  /** Same rise, maximum: skip curves that already sprinted inside one window. */
  maxRise: number;
  /** Second-half net inflow must be at least this many times the first half's. */
  accelRatio: number;
  /** Price now must be at least this fraction of the window's high. */
  highShare: number;
  /** Real SOL a curve must hold to be buyable, lower and upper bound. */
  minReserve: number;
  maxReserve: number;
  /** Slots since the CreateEvent before a buy is allowed. */
  minMaturity: number;
  /** SOL committed to one position in a single buy. */
  sizeSol: number;
  /** Smallest buy worth sending. */
  minOrderSol: number;
  /** Slippage allowed on buys, in bps; sells always go out at 10000. */
  buySlippage: number;
  /** Sell when the position is worth this fraction less than its cost. */
  stopPct: number;
  /** Sell when the position is worth this fraction less than its best value. */
  trailPct: number;
  /** The trail only arms once the position has been worth cost * (1 + trailArmPct). */
  trailArmPct: number;
  /** Sell after this many slots held, unless the position is up at least holdGain. */
  maxAge: number;
  /** The time cap is waived while the position is up at least this much. */
  holdGain: number;
  /** Slots to wait after an exit before the same curve can be bought again. */
  coolOff: number;
  /** Most buys allowed per curve over the whole run. */
  maxTries: number;
  /** Most momentum positions open at once (the remaining open-position budget is for probes). */
  maxPositions: number;
  /**
   * Guardrail pacing: the run must finish with a round trip of at least 0.01 SOL on at
   * least 20 coins. While the bot's own fills or coins trail goalFills / goalCoins scaled
   * by the share of paceWindow elapsed (block time since the first batch), it opens tiny
   * probe round trips (buy probeSize, sell it all once the buy lands) until it is back
   * on pace.
   */
  goalCoins: number;
  goalFills: number;
  paceWindow: number;
  probeSize: number;
  maxProbeCount: number;
  /** Most SOL at cost held across all positions at once (a drawdown guard). */
  maxAtRisk: number;
}

export const DEFAULT_PARAMS: Config = {
  span: 40,
  minFlow: 0.5,
  minPrints: 4,
  minWallets: 4,
  minRise: 0.04,
  maxRise: 2.0,
  accelRatio: 1,
  highShare: 0.95,
  minReserve: 1,
  maxReserve: 80,
  minMaturity: 300,
  sizeSol: 0.15,
  minOrderSol: 0.02,
  buySlippage: 1500,
  stopPct: 0.08,
  trailPct: 0.1,
  trailArmPct: 0.05,
  maxAge: 1500,
  holdGain: 0.2,
  coolOff: 150,
  maxTries: 2,
  maxPositions: 5,
  goalCoins: 25,
  goalFills: 240,
  paceWindow: 14_400,
  probeSize: 0.02,
  maxProbeCount: 1,
  maxAtRisk: 8,
};

const LAMPORTS_PER_SOL = 1e9;
const CURVE_TAKE = 0.0125;
const BPS_DENOM = 10_000;

interface Print {
  at: number;
  isBuy: boolean;
  vol: number;
  who: string;
  px: number;
}

interface Book {
  born: number | null;
  prints: Print[];
  tries: number;
  lastOut: number;
}

interface Leg {
  openedAt: number;
  best: number;
  /** SOL sent in buys for this position (fees included). */
  spent: number;
  closing: boolean;
  /** At least one buy of this position filled. */
  landed: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  worth: number;
}

/** Window statistics gathered in one pass over a curve's prints. */
interface WindowStats {
  buys: number;
  buyers: number;
  net: number;
  netEarly: number;
  netLate: number;
  firstPx: number;
  topPx: number;
  pxNow: number;
}

export function createStrategy(cfg: Config = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, Book>();
  const legs = new Map<Pubkey, Leg>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probeState = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let fillCount = 0;
  const coinsTouched = new Set<Pubkey>();
  let clockStart: number | null = null;
  let clockEnd: number | null = null;
  const keepSpan = cfg.span + 5;

  const bookFor = (mint: Pubkey): Book => {
    const found = books.get(mint);
    if (found !== undefined) return found;
    const fresh: Book = { born: null, prints: [], tries: 0, lastOut: -1e12 };
    books.set(mint, fresh);
    return fresh;
  };

  /**
   * One pass over a book's prints: window flow, buyers, and price shape at slot `now`.
   * A print at or before the window's start sets the opening price (the last such print
   * wins); the first print inside the window sets it only when no earlier print did.
   */
  const scanWindow = (book: Book, now: number): WindowStats => {
    const start = now - cfg.span;
    const middle = now - cfg.span / 2;
    let buyVol = 0;
    let sellVol = 0;
    let buys = 0;
    let early = 0;
    let late = 0;
    let firstPx = -1;
    let topPx = 0;
    let pxNow = 0;
    const wallets = new Map<string, number>();
    for (const pr of book.prints) {
      if (pr.at <= start) {
        firstPx = pr.px;
        continue;
      }
      if (firstPx < 0) firstPx = pr.px;
      const signed = pr.isBuy ? pr.vol : -pr.vol;
      if (pr.at <= middle) early += signed;
      else late += signed;
      if (pr.isBuy) {
        buyVol += pr.vol;
        buys++;
        wallets.set(pr.who, (wallets.get(pr.who) ?? 0) + pr.vol);
      } else {
        sellVol += pr.vol;
      }
      if (pr.px > topPx) topPx = pr.px;
      pxNow = pr.px;
    }
    return {
      buys,
      buyers: wallets.size,
      net: buyVol - sellVol,
      netEarly: early,
      netLate: late,
      firstPx,
      topPx,
      pxNow,
    };
  };

  /** Entry signal on a curve's book at slot `now`. */
  const qualifies = (book: Book, now: number, reserveSol: number): boolean => {
    if (reserveSol < cfg.minReserve || reserveSol > cfg.maxReserve) return false;
    if (book.born === null || now - book.born < cfg.minMaturity) return false;
    const s = scanWindow(book, now);
    if (s.buys < cfg.minPrints || s.buyers < cfg.minWallets) return false;
    if (s.net < cfg.minFlow) return false;
    if (s.firstPx <= 0) return false;
    const rise = s.pxNow / s.firstPx - 1;
    if (rise < cfg.minRise || rise > cfg.maxRise) return false;
    if (s.pxNow < s.topPx * cfg.highShare) return false;
    if (s.netLate <= 0 || s.netLate < cfg.accelRatio * s.netEarly) return false;
    return true;
  };

  /** True when a leg should be closed at this batch's value. */
  const shouldClose = (leg: Leg, value: number, cost: number, now: number): boolean => {
    if (leg.closing) return true;
    if (value < cost * (1 - cfg.stopPct)) return true;
    if (leg.best >= cost * (1 + cfg.trailArmPct) && value < leg.best * (1 - cfg.trailPct)) return true;
    if (now - leg.openedAt > cfg.maxAge && value < cost * (1 + cfg.holdGain)) return true;
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          fillCount++;
          coinsTouched.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (clockStart === null) clockStart = e.block_time;
          if (clockEnd === null || e.block_time > clockEnd) clockEnd = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          bookFor(e.mint).born = e.slot;
        } else if (e.event === 'TradeEvent') {
          const book = bookFor(e.mint);
          const vol = Number(e.sol_amount) / LAMPORTS_PER_SOL;
          book.prints.push({
            at: e.slot,
            isBuy: e.is_buy,
            vol,
            who: e.user,
            px: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          touched.add(e.mint);
        }
      }
      for (const mint of touched) {
        const book = books.get(mint)!;
        let cut = book.prints.findIndex((pr) => pr.at > now - keepSpan);
        if (cut === -1) cut = book.prints.length;
        if (cut > 0) book.prints.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingCount = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingCount.set(po.order.mint, (pendingCount.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const batchCap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS_PER_SOL;

      // Exits first.
      for (const [mint, leg] of legs) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingCount.has(mint)) {
            legs.delete(mint);
            const book = bookFor(mint);
            if (leg.landed) book.lastOut = now;
            else book.tries--;
          }
          continue;
        }
        leg.landed = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const raw = (tokens * vq) / (vt + tokens) / LAMPORTS_PER_SOL;
        const value = raw * (1 - CURVE_TAKE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS_PER_SOL;
        if (value > leg.best) leg.best = value;
        leg.worth = value;
        if (!shouldClose(leg, value, cost, now)) continue;
        leg.closing = true;
        if (pendingCount.has(mint)) {
          let sellInFlight = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellInFlight = true;
          }
          if (sellInFlight) continue;
        }
        if (orders.length >= batchCap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probeState) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingCount.has(mint)) probeState.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingCount.has(mint)) continue;
        if (orders.length >= batchCap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probeState.set(mint, true);
      }

      // Then entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS_PER_SOL;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = cfg.maxPositions - legs.size;
      let exposure = 0;
      for (const [mint, leg] of legs) {
        exposure += Math.max(leg.spent, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS_PER_SOL);
      }
      for (const mint of touched) {
        if (orders.length >= batchCap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingCount.has(mint) || probeState.has(mint) || legs.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const book = books.get(mint)!;
        if (book.tries >= cfg.maxTries || now - book.lastOut < cfg.coolOff) continue;
        const reserveSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
        if (!qualifies(book, now, reserveSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS_PER_SOL;
        let amount = Math.min(capSol, cfg.sizeSol, cfg.maxAtRisk - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < cfg.minOrderSol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: cfg.buySlippage });
        free -= amount + tx;
        exposure += amount;
        legs.set(mint, { openedAt: now, best: 0, spent: amount, closing: false, landed: false, worth: 0 });
        book.tries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probeState.size < cfg.maxProbeCount && slotsLeft > 0 && clockStart !== null && clockEnd !== null) {
        const pace = Math.min(1, (clockEnd - clockStart) / cfg.paceWindow);
        const needCoins = coinsTouched.size < Math.ceil(cfg.goalCoins * pace);
        const needFills = fillCount < Math.ceil(cfg.goalFills * pace);
        if (needCoins || needFills) {
          const minRq = (cfg.probeSize * Number(BPS_DENOM)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= batchCap || probeState.size >= cfg.maxProbeCount) break;
            if (legs.has(mint) || probeState.has(mint) || pendingCount.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && coinsTouched.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL < minRq * 1.5) continue;
            if (free < cfg.probeSize + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(cfg.probeSize * LAMPORTS_PER_SOL)), max_slippage_bps: cfg.buySlippage });
            probeState.set(mint, false);
            free -= cfg.probeSize + tx;
          }
        }
      }
      return orders;
    },
  };
}
