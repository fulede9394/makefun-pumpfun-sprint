# Pump.fun Paper Sprint — Momentum Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/fulede9394/makefun-pumpfun-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/fulede9394/makefun-pumpfun-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) — a paper-trading bot for the `agent-fun/replay/v2` pump.fun replay. One program, `main.ts` on Node 22, no dependencies; the only vendored file is the kit's SDK shim (`vendor/makefun-bot.ts`).

## Strategy

Simple momentum with fixed risk rules, no pyramiding:

- **Entry** — a curve becomes a buy when it is mature (≥ 300 slots since creation, so fresh bundled launches are skipped), its real SOL reserve sits between 1 and 80 SOL, and its last 40 slots of tape show accelerating buy pressure: net inflow ≥ 0.5 SOL, ≥ 4 buys from ≥ 4 distinct wallets, price up ≥ 4% and within 5% of the window high, with the newer half of the window pulling in at least as much as the older half.
- **Size** — one fixed 0.15 SOL buy per position, capped by the 1%-of-real-reserve order cap and free cash; at most 5 positions, at most 8 SOL of exposure at cost.
- **Exit** — sell the whole position on the first of: stop-loss at −8% of cost, trailing stop at −10% from the peak (armed at +5%), or a 1500-slot time cap (waived while up ≥ 20%).
- **Guardrail probes** — tiny 0.02 SOL round trips, opened only when the bot's fills or distinct coins lag the pace needed to clear the minimum bar (a ≥ 0.01 SOL round trip on ≥ 20 coins), sold as soon as the buy lands.

Deterministic by construction: no clock, no randomness; every decision comes from the batch stream, so two runs produce identical action logs.

## Files

- `main.ts` — entrypoint: runs the strategy through the SDK shim.
- `strategy.ts` — the strategy (entry signal, exits, probes).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `LICENSE` — MIT.
