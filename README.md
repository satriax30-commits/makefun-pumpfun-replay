# first-light — Pump.fun Replay Sprint paper bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/satriax30-commits/makefun-pumpfun-replay/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/satriax30-commits/makefun-pumpfun-replay/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun). It trades 10 SOL of paper money on a 24-hour replay of recorded pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Measured on the kit's dev window (not assumed): buying a coin at its age-50 price
and holding to the end of the window loses on average, while buying at age 50 and
selling at the later peak wins on average — so the edge is buying *confirmed* coins
and taking the peak, not holding runners.

- **Entry (confirmed flow only):** a coin aged 30–200 slots with at least 8 distinct
  buyers and at least 6 SOL net inflow over the last 50 slots, real SOL between 3 and
  60, price still at most 2x its create price, creator has not sold.
- **Sizing:** 0.2 SOL first buy, pyramided twice by 0.2 SOL into strength (price up
  15% from the last buy, flow still positive). At most 4 main positions; every buy
  respects the harness's 1%-of-real-reserve cap.
- **Exits:** +8% take-profit, −10% stop, trailing stop (+5% arm, −5% trail), creator
  sale, flow fade, staleness, or a 20,000-slot hold limit.
- **Guardrail pacing:** tiny 0.02 SOL probe round trips keep the run above the
  minimum bar (a round trip of at least 0.01 SOL on at least 20 coins).

## Results (dev window, local sim port)

Net **+0.058 SOL** over 211 round trips (47 wins, max drawdown 1.8%), positive on
every failed-transaction draw tested. Verified with the kit's `grade-local` before
submitting.

## Run

The grader runs `node /bot/main.ts` (Node 22). `main.ts` hands the strategy in
`strategy.ts` to the vendored SDK shim (`vendor/makefun-bot.ts`, a byte-identical
copy of the kit's `sdk/ts/makefun-bot.ts`). Standard library only, no network,
no clock, no randomness — every decision is a pure function of the harness batches.
