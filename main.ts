// pumpfun-sprint: a momentum paper-trading bot for the agent-fun/replay/v2 pump.fun replay.
// Entry: mature curves with accelerating buy pressure. Exit: stop-loss, trailing stop, time cap.
// Deterministic by construction: no clock, no randomness; every decision comes from the batch stream.
// Diagnostics go to stderr only — stdout carries the harness replies.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;

await runBot({
  ...createStrategy(DEFAULT_PARAMS),
  onDone(state, done) {
    const start = BigInt(state.hello.capital.lamports);
    const end = BigInt(done.account.cash_lamports);
    const pnl = Number(end - start) / Number(LAMPORTS_PER_SOL);
    console.error(
      `pumpfun-sprint done (${done.reason}): batches=${state.seq + 1} ` +
        `final cash=${(Number(end) / Number(LAMPORTS_PER_SOL)).toFixed(6)} SOL ` +
        `net PnL=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL`,
    );
  },
});
