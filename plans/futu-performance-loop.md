# Futu performance loop: history K-lines, fills, fees, slippage, stats

Status: Increments A, B, and C are complete and unit-tested. Increment D is
implemented and typechecked with focused lib/hook/component/page tests; its
required real-browser demo-route walk remains blocked because no browser
backend is available in this environment. This file doubles as the handoff spec
(written so a fresh Codex/Claude session can execute without re-deriving
context). Read the whole file before editing anything.

Related owner guides: [[docs/market-data-architecture.md]],
[[docs/uta-live-testing.md]]. Related plans: [[plans/uta-broker-futu.md]]
(the Futu broker this builds on — all its increments are complete),
[[plans/futu-realtime-quotes.md]] (complete).

## Goal

Maintainer-directed: build the measurement loop that lets the trader see
whether their strategy is actually working — win rate, profit factor,
expectancy, max drawdown — **with real trading fees included** (a win rate
that ignores fees is self-deception), plus fill-level slippage where a
recorded reference price makes it honest, and real entitled historical
K-lines for Futu so agent analysis stops depending on free delayed feeds.

None of this raises win rate by itself; it makes decision quality and
strategy errors visible. Same honesty ceiling as every Futu increment:
no FutuOpenD gateway or Futu account is available in this environment —
everything is verified against mocked gateways only. NEVER fabricate a
value the wire did not carry; absent data stays absent.

## Grounded protocol facts (verified against bundled futu-api protos)

- `Qot_RequestHistoryKL` (cmd 3103, SDK `RequestHistoryKL`): C2S
  rehabType/klType/security/beginTime/endTime (+maxAckKLNum, nextReqKey
  pagination); S2C klList of `Qot_Common.KLine` (time, isBlank, OHLC,
  volume, timestamp) + nextReqKey. `KLType`: 1Min=1, Day=2, Week=3,
  5Min=6, 15Min=7, 30Min=8, 60Min=9, 240Min=15. `RehabType_Forward = 1`.
- `Trd_UpdateOrderFill` push (cmd 2218): S2C field is `orderFill`
  (one `Trd_Common.OrderFill`). Registered by the same `Trd_SubAccPush`
  (cmd 2008) already wired for order pushes.
- `Trd_GetOrderFee` (cmd 2225, SDK `GetOrderFee`): C2S header +
  `orderIdExList` (lowercase d; SERVER order ids = orderIDEx, not the
  numeric orderID); S2C `orderFeeList` of `Trd_Common.OrderFee`
  (orderIDEx, feeAmount, feeList title/value pairs).

## Ledger reality (verified in code — line refs from this branch)

- Fees are recorded NOWHERE in the ledger today (`commissionAndFees` has
  zero hits in services/uta and uta-protocol outside the IBKR class def).
- History rows are projections of the Trading-as-Git commit log
  (`services/uta/src/domain/trading/order-history.ts`).
- The sync writer: `UnifiedTradingAccount.ts` ~line 880–915 builds
  `OrderStatusUpdate` rows (`{ orderId, symbol, previousStatus,
  currentStatus, filledQty, filledPrice: brokerOrder.avgFillPrice }`) from
  `getOrders()` results and hands them to `this.git.sync(updates, state)`.
- Result shapes (`packages/uta-protocol/src/types/git.ts`):
  `OperationResult` (~line 60, has `filledQty?/filledPrice?` and even
  `orderState?`) and `OrderStatusUpdate` (~line 178, has
  `filledPrice?/filledQty?`).
- `OrderState.commissionAndFees: number` defaults to the `UNSET_DOUBLE`
  sentinel (`packages/ibkr/src/order-state.ts` line 50) — always compare
  against `UNSET_DOUBLE` before treating it as data.
- Slippage reference prices: `OrderHistoryEntry` records `limitPrice` and
  `avgFillPrice`, so limit-order slippage is computable today. Market
  orders have no recorded reference price → report them as untracked
  rather than fabricating a reference.

## Increments

- [x] **A — Futu historical K-lines. DONE.**
  `FutuGateway.requestHistoryKL` (one page per call; caller owns the
  nextReqKey loop), `FutuBroker.getHistorical` maps every `BarInterval`
  (all 8, incl. 4h→KLType 240Min) with RehabType_Forward, derives the
  required time window from `limit` when `start` is absent
  (interval × count × 3 calendar buffer), drops `isBlank`/OHLC-less rows
  instead of zero-filling, sorts ascending, tail-slices to most-recent
  `limit`. Capability now declares `historicalBars: { supported: true,
  quality: 'subscription', supportedBarSizes: [all 8] }`. Pagination is
  capped at 20 pages × 1000 rows.
- [x] **B — Futu fill push + fees at the broker boundary. DONE.**
  `subscribeOrderUpdates` gained an optional `onFill` callback
  (Trd_UpdateOrderFill, s2c.orderFill); FutuBroker uses it to DELETE the
  affected cached order row (fills are deltas — the next read re-pulls
  authoritative cumulative state; merging would be guesswork).
  `FutuGateway.getOrderFee(header, orderIDExList)` wraps Trd_GetOrderFee
  (empty list short-circuits). `FutuBroker.getOrders/getOrder` batch-fetch
  fees for fee-bearing rows (orderStatus FilledPart/FilledAll/
  CancelledPart) through an immutable `feeCache` keyed by orderIDEx, then
  `toOpenOrder` sets `orderState.commissionAndFees` (+
  `commissionAndFeesCurrency` from the row's currency enum). Fee lookup
  failure is non-fatal (fees omitted that read, retried next read).
  Verification: FutuBroker.spec.ts + FutuGatewayClient.spec.ts = 92 tests
  green; root `npx tsc --noEmit` clean.

- [x] **C — fees into the ledger and history projection. DONE.** Optional
  Decimal-string fee fields now flow from broker sync through commits into
  order/trade projections and UI mirrors; sentinel/non-finite values stay absent.
- [ ] **D — performance stats panel. IMPLEMENTED; BROWSER WALK BLOCKED.** FIFO
  round trips, fee-adjusted stats and coverage, drawdown, honest slippage, a
  computation-only hook, responsive disclosure UI, and demo fixtures are in
  place. The in-app browser runtime reported no available browser, so the
  required `/settings/uta/demo-paper` visual/interaction walk remains open.

## Increment C handoff — fees: broker → sync → commit → projection

Every step is additive-optional; old commits simply project no fee. This
is a shipped persisted shape upstream, but adding OPTIONAL fields needs no
migration (absence is the pre-change meaning; nothing rewrites old data).

1. `packages/uta-protocol/src/types/git.ts`:
   - `OrderStatusUpdate` (~line 178): add
     `fee?: string` (Decimal-as-string, matching filledPrice convention)
     and `feeCurrency?: string`.
   - `OperationResult` (~line 60): add the same two optional fields.
2. `services/uta/src/domain/trading/UnifiedTradingAccount.ts` (~line 898,
   the `updates.push({...})` inside the order-sync loop): copy fees from
   `brokerOrder.orderState.commissionAndFees` — ONLY when it is a finite
   number and `!== UNSET_DOUBLE` (import from `@traderalice/ibkr`) — as
   `fee: String(...)`, plus `feeCurrency:
   brokerOrder.orderState.commissionAndFeesCurrency || undefined`.
3. `services/uta/src/domain/trading/TradingGit.ts` — find `sync(updates,
   state)`: it maps each `OrderStatusUpdate` into a commit
   `OperationResult`. Carry `fee`/`feeCurrency` through that mapping.
   Read the file first; keep its existing field-copy style.
4. `packages/uta-protocol/src/types/history.ts`: add optional
   `fee?: string` + `feeCurrency?: string` to BOTH `OrderHistoryEntry`
   and `TradeHistoryEntry`.
5. `services/uta/src/domain/trading/order-history.ts`:
   - `projectOrderHistory`: in the sync-commit resolution block (~line
     115–125, `if (result.filledQty) target.filledQty = ...`), also copy
     `result.fee`/`result.feeCurrency` onto the entry when present.
   - `projectTradeHistory`: in the sync-fill push block (~line 189–206),
     pass fee/feeCurrency into the pushed trade row.
6. Mirror the two new optional fields on the UI types
   (`ui/src/api/types.ts` — find `TradeHistoryEntry`/`OrderHistoryEntry`
   mirrors) so Increment D can read them. Do NOT add UI rendering here.
7. Tests (extend existing specs, follow their style):
   - `order-history` projection spec (find the existing spec file for
     order-history.ts): a sync commit result carrying fee/feeCurrency
     projects onto both history row kinds; a result without fees leaves
     the fields undefined.
   - `UnifiedTradingAccount.spec.ts`: sync copies
     orderState.commissionAndFees into the update; UNSET_DOUBLE and
     missing orderState produce NO fee field (assert absence, not 0).
8. Verification: `npx tsc --noEmit` (root), targeted vitest on the two
   spec files above + the Futu specs, and
   `pnpm -F @traderalice/uta-protocol typecheck`. Do NOT run the full
   monorepo `pnpm test` on a constrained machine (vitest fork-pool
   exhaustion is a known machine issue, not a code signal).

## Increment D handoff — performance stats panel (UI)

Per the repo's UI design workflow (AGENTS.md), state the design choice in
the PR/plan before coding. The pre-agreed scope from the maintainer:

- **Data**: existing trade history + order history + equity curve the
  UTADetailPage already fetches. NO new backend endpoint — stats are a
  pure projection. Frontend reads must go through a domain hook
  (repo convention), presentation stays prop-driven.
- **Pure lib** `ui/src/lib/trade-stats.ts` (unit-test heavily):
  - FIFO round-trip matching over `TradeHistoryEntry[]` per contract
    (match BUY lots against SELL lots, quantity-weighted) → closed
    round trips with realized PnL each.
  - Win rate = winning round trips / closed round trips (exclude
    `source: 'reconcile'` rows — they are balance-drift foldings, not
    real fills).
  - Profit factor = gross profit / gross loss; expectancy = mean PnL per
    closed round trip. **Fees**: subtract per-order `fee` (from Increment
    C) where present; report an explicit coverage marker
    ("fees known for N of M orders") instead of pretending totals are
    complete when fee data is partial.
  - Max drawdown from `EquityCurvePoint[]` (peak-to-trough on the curve).
  - Limit-order slippage: for filled orders with BOTH `limitPrice` and
    `avgFillPrice`, aggregate (fill − limit) signed by side. Market
    orders: count them as "untracked" — no reference price exists in the
    ledger; do not synthesize one.
  - Every monetary computation uses decimal.js, never float arithmetic.
- **Hook** `ui/src/hooks/useTradeStats.ts`: composes the page's existing
  data (pass rows in; keep the hook computation-only so it is trivially
  testable). Unit tests for selection + empty/loading semantics.
- **UI**: one new collapsible section on `UTADetailPage.tsx` ("績效統計"
  / Performance), placed after the Positions section. Stat tiles (win
  rate, profit factor, expectancy, max drawdown, total fees, slippage) +
  the fee-coverage honesty marker + an empty state ("尚無已平倉交易")
  when there are no closed round trips. Reuse shared UI primitives from
  `ui/src/components/ui/`; no bespoke motion (respect reduced-motion by
  not animating numbers).
- **Demo**: extend `ui/src/demo/fixtures/trading.ts` so the demo UTAs
  produce at least one non-trivial stats rendering; walk
  `pnpm -F open-alice-ui dev:demo` and verify
  `/settings/uta/demo-paper` in a real browser.
- Verification: `cd ui && npx tsc -b`, targeted vitest for the new lib +
  hook + page specs, plus the demo-route browser walk above.

## Working agreements for the executing agent

- Branch: continue on `feat/uta-broker-futu`; push to
  `myfork` = `ipass003482/OpenAliceflow` (NOT upstream). Commit style:
  follow this branch's history (what/why/verification/explicit
  exclusions, Co-authored-by trailer).
- Machine quirks (this dev machine): grep/Select-String sometimes read
  encrypted garbage — trust the `view` tool and `git grep`; full
  `pnpm test` exhausts vitest fork workers — run targeted spec files.
- Update THIS file's checkboxes and the [[PLANS.md]] index line in the
  same change as the work; delete this plan only when C and D are both
  accepted.

## Explicitly out of scope

- Live verification against a real FutuOpenD gateway/account.
- Market-order slippage vs a synthetic reference price (would fabricate
  data the ledger never recorded).
- Backfilling fees for historical commits (no data source exists).
- A parallel analytics service — stats are a pure projection of data the
  UI already receives.
