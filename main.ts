// first-light: a confirmed-flow rider for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Tuned on the kit's dev window with the local sim port: enter coins aged 30-200 slots
// with >= 8 distinct buyers and >= 6 SOL net inflow over the last 100 slots while the
// price is still <= 2x its create price; stake 0.2 SOL, pyramid twice into strength;
// exit on +8% take-profit, -10% stop, +5% arm / -5% trailing stop, dev sale, flow fade,
// staleness or a 20,000-slot hold limit. Dev net +0.058 SOL over 211 round trips.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
