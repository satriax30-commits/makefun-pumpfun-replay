// Confirmed-flow rider for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window actually shows (measured on the kit's own dataset, not assumed):
//   - Every curve that completes ends at the same 14.7x its create price, but only 35 of
//     1222 universe coins complete (2.9%), and the ones that do are mostly already far
//     up by the time they are obvious (net50 >= 20 SOL -> 45% complete, but already ~8x).
//   - Buying at a coin's age-50 price and holding to the end of the window LOSES on
//     average (0.64-0.85x). Buying at age 50 and selling at the later peak WINS on
//     average (1.15-1.54x). So the edge is not holding runners: it is buying confirmed
//     coins and taking the peak with a take-profit plus a trailing stop.
//   - The confirmation that works: many distinct buyers and sustained net inflow over
//     the first 50 slots, with the price still modest (buyers50 >= 10 and net50 >= 5
//     with price <= 3x -> 1.52x average peak after entry, 9 of 175 reach >= 3x after).
//   - A coin's create price is nearly its floor inside one window: even dead coins
//     usually end above it. So entries are timed on sustained flow, not on the launch
//     itself, and exits are what make the money.
//
// The bot therefore waits for confirmation (age 30-200 slots), buys coins with many
// distinct buyers, positive sustained flow and a price still in [1x, 3x] of create,
// pyramids into strength only, and exits on a take-profit, a stop, a trailing stop
// once the trade is working, a dev sale, a flow fade, staleness or a hard time limit.
//
// The minimum bar (a round trip of at least 0.01 SOL on at least 20 coins, drawdown
// at most 50%) is guarded by pacing probes: when the bot's own filled coins or fills
// lag a block-time pace, it opens a tiny probe round trip on a liquid curve and sells
// it as soon as the buy lands.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream; every decision is a pure function of
// the hello, the batches seen so far and the account the harness reports.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin on the first buy. */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Distinct (non-creator) buyers seen in the confirm window, at least. */
  minBuyers: number;
  /** Net SOL flow over the confirm window, at least (lamports). */
  minFlowLamports: number;
  /** Window (slots) for the buyer/flow confirmation. */
  confirmWindow: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Skip a launch whose creator has already sold. */
  skipDevSold: boolean;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports (0 = off). */
  exitFlowLamports: number;
  /** Recent window (slots) for the exit flow check. */
  exitFlowWindow: number;
  /** Add to a position while it keeps qualifying, up to this many adds. */
  maxAdds: number;
  /** Lamports per add. */
  addLamports: number;
  /** An add needs the price at least this far (bps) above the previous buy's decision price. */
  addStepBps: number;
  /** An add needs the recent net flow at least this (lamports). */
  addMinFlowLamports: number;
  /** Most main positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /**
   * Guardrail pacing: the run must end with at least 20 coins and 200 fills. When the bot's
   * own fills or coins lag targetFills / targetCoins scaled by the share of paceSecs elapsed
   * (block time since the first batch), it opens tiny probe round trips (buy probeSol, sell it
   * all as soon as the buy lands) until it is back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 30,
  maxAge: 200,
  stakeLamports: 200_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 3_000_000_000,
  maxRealSol: 60_000_000_000,
  minBuyers: 8,
  minFlowLamports: 6_000_000_000,
  confirmWindow: 100,
  minRunupBps: 0,
  maxRunupBps: 10_000,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tpBps: 800,
  slBps: 1_000,
  trailArmBps: 500,
  trailBps: 500,
  maxHold: 20_000,
  exitOnDevSell: true,
  staleSlots: 3_000,
  exitFlowLamports: 2_000_000_000,
  exitFlowWindow: 50,
  maxAdds: 2,
  addLamports: 200_000_000,
  addStepBps: 1_500,
  addMinFlowLamports: 1_000_000_000,
  maxMain: 4,
  maxExposureSol: 6,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125; // protocol 95 + creator 30 bps, the curve fee on each side
const BPS = 10_000;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  trades: number;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last confirmWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  addsSent: number;
  /** Decision price (vq/vt as a pair) of the last buy sent. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  bestValue: bigint;
  exiting: boolean;
}

/** Distinct non-creator buyers and net SOL flow over the last `w` slots. */
function windowStats(recent: Tick[], creator: Pubkey, now: number, w: number): { buyers: number; net: bigint } {
  const buyers = new Set<Pubkey>();
  let net = 0n;
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i]!;
    if (t.slot <= now - w) break;
    if (t.isBuy) {
      net += t.sol;
      if (t.user !== creator) buyers.add(t.user);
    } else {
      net -= t.sol;
    }
  }
  return { buyers: buyers.size, net };
}

/** What selling `tokens` would pay, curve fees and one tx fee deducted. */
function liquidationValue(vq: bigint, vt: bigint, rq: bigint, tokens: bigint, txFee: bigint): bigint {
  if (vt + tokens === 0n) return -txFee;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  const fee = (q * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
  return q - fee - txFee;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin | undefined => coins.get(mint);

  /** Entry filter on a coin at slot `now`. */
  const entryOk = (c: Coin, now: number, rq: bigint, vq: bigint, vt: bigint): boolean => {
    const age = now - c.createSlot;
    if (age < p.minAge || age > p.maxAge) return false;
    if (rq < BigInt(p.minRealSol) || rq > BigInt(p.maxRealSol)) return false;
    if (p.skipDevSold && c.devSold) return false;
    const s = windowStats(c.recent, c.creator, now, p.confirmWindow);
    if (s.buyers < p.minBuyers) return false;
    if (s.net < BigInt(p.minFlowLamports)) return false;
    // Price run-up from the create price, in bps (cross-multiplied, no floats).
    if (c.vq0 > 0n && c.vt0 > 0n && vt > 0n) {
      const runup = ((vq * c.vt0 * BigInt(BPS)) / (vt * c.vq0)) - BigInt(BPS);
      if (runup < BigInt(p.minRunupBps) || runup > BigInt(p.maxRunupBps)) return false;
    }
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFee = state.txFeeLamports();
      const touched: Pubkey[] = [];
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          if (!coins.has(e.mint)) {
            coins.set(e.mint, {
              mint: e.mint,
              createSlot: e.slot,
              creator: e.creator,
              vq0: BigInt(e.virtual_quote_reserves),
              vt0: BigInt(e.virtual_token_reserves),
              trades: 0,
              devSold: false,
              lastTradeSlot: e.slot,
              recent: [],
              buysSent: 0,
              addsSent: 0,
              lastBuyVq: 0n,
              lastBuyVt: 1n,
              done: false,
              complete: false,
            });
          }
        } else if (e.event === 'TradeEvent') {
          let c = coins.get(e.mint);
          if (c === undefined) {
            c = {
              mint: e.mint,
              createSlot: e.slot,
              creator: e.creator,
              vq0: BigInt(e.virtual_quote_reserves),
              vt0: BigInt(e.virtual_token_reserves),
              trades: 0,
              devSold: false,
              lastTradeSlot: e.slot,
              recent: [],
              buysSent: 0,
              addsSent: 0,
              lastBuyVq: 0n,
              lastBuyVt: 1n,
              done: false,
              complete: false,
            };
            coins.set(e.mint, c);
          }
          const sol = BigInt(e.sol_amount);
          c.trades++;
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
          if (c.recent.length > 400) c.recent.splice(0, c.recent.length - 400);
          if (!e.is_buy && e.user === c.creator) c.devSold = true;
          if (touched[touched.length - 1] !== e.mint && !touched.includes(e.mint)) touched.push(e.mint);
        } else if (e.event === 'CompleteEvent') {
          const c = coins.get(e.mint);
          if (c !== undefined) c.complete = true;
        }
      }
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint; rq: bigint } | null => {
        const mk = marks.get(mint);
        if (mk !== undefined) {
          return { vq: BigInt(mk.virtual_quote_reserves), vt: BigInt(mk.virtual_token_reserves), rq: BigInt(mk.real_quote_reserves) };
        }
        const curve = state.curves.get(mint);
        if (curve === undefined) return null;
        return { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves, rq: curve.real_quote_reserves };
      };

      // Exits first: every held position is re-priced against its latest reserves.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (c !== undefined) c.done = true;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const r = reservesOf(mint);
        if (r === null) continue;
        const value = liquidationValue(r.vq, r.vt, r.rq, BigInt(pos.token_amount), txFee);
        const cost = BigInt(pos.cost_lamports);
        if (value > h.bestValue) h.bestValue = value;
        const c = coinOf(mint);
        let exit = h.exiting;
        if (!exit && cost > 0n && value * BigInt(BPS) >= cost * BigInt(BPS + p.tpBps)) exit = true;
        if (!exit && cost > 0n && value * BigInt(BPS) <= cost * BigInt(BPS - p.slBps)) exit = true;
        if (!exit && h.bestValue > 0n && h.bestValue * BigInt(BPS) >= cost * BigInt(BPS + p.trailArmBps) && value * BigInt(BPS) <= h.bestValue * BigInt(BPS - p.trailBps)) exit = true;
        if (!exit && p.exitOnDevSell && c !== undefined && c.devSold) exit = true;
        if (!exit && now - h.openedSlot > p.maxHold) exit = true;
        if (!exit && c !== undefined && now - c.lastTradeSlot > p.staleSlots) exit = true;
        if (!exit && p.exitFlowLamports > 0 && c !== undefined && windowStats(c.recent, c.creator, now, p.exitFlowWindow).net < -BigInt(p.exitFlowLamports)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries and adds: only coins touched by this batch.
      let free = state.freeCashLamports();
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0n;
      for (const [mint] of held) exposure += BigInt(state.positions.get(mint)?.cost_lamports ?? 0n);
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint)!;
        const r = reservesOf(mint);
        if (r === null) continue;
        const h = held.get(mint);
        let amount: bigint;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (c.done || c.buysSent > 0) continue;
          if (!entryOk(c, now, r.rq, r.vq, r.vt)) continue;
          amount = BigInt(p.stakeLamports);
        } else {
          // Pyramid into strength only: the price stepped up from the last buy's decision
          // price and net flow over the confirm window is still positive.
          if (h.exiting || c.addsSent >= p.maxAdds) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (c.lastBuyVt === 0n) continue;
          const step = ((r.vq * c.lastBuyVt * BigInt(BPS)) / (r.vt * c.lastBuyVq)) - BigInt(BPS);
          if (step < BigInt(p.addStepBps)) continue;
          if (windowStats(c.recent, c.creator, now, p.confirmWindow).net < BigInt(p.addMinFlowLamports)) continue;
          amount = BigInt(p.addLamports);
        }
        const capLamports = state.maxBuyLamports(mint);
        if (amount > capLamports) amount = capLamports;
        const maxExposure = BigInt(Math.floor(p.maxExposureSol * LAMPORTS));
        if (amount > maxExposure - exposure) amount = maxExposure - exposure;
        if (amount > free - txFee) amount = free - txFee;
        if (amount < BigInt(p.minBuyLamports)) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + txFee;
        exposure += amount;
        if (h === undefined) {
          c.buysSent++;
          c.lastBuyVq = r.vq;
          c.lastBuyVt = r.vt;
          held.set(mint, { openedSlot: now, bestValue: 0n, exiting: false });
          slotsLeft--;
          mainLeft--;
        } else {
          c.addsSent++;
          c.lastBuyVq = r.vq;
          c.lastBuyVt = r.vt;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const probeLamports = BigInt(Math.floor(p.probeSol * LAMPORTS));
          const minRq = (probeLamports * BigInt(BPS)) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (minRq * 3n) / 2n) continue;
            if (free < probeLamports + 2n * txFee) break;
            orders.push({ side: 'buy', mint, quote_lamports: probeLamports, max_slippage_bps: p.buySlippageBps });
            probes.set(mint, false);
            free -= probeLamports + txFee;
          }
        }
      }
      return orders;
    },
  };
}
