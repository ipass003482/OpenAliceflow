# Futu Real-Time Quote Streaming

Status: increment 1 (FutuGateway/FutuBroker subscription layer) in progress.

Related owner guides: [[docs/market-data-architecture.md]],
[[docs/broker-packs.md]]. Related plan: [[plans/uta-broker-futu.md]] (this
plan assumes that plan's Increment 1 — read-only FutuBroker — already exists
and extends it with a genuinely different capability: live push, not
request/response).

## Origin and grounded facts

The maintainer's own Futu account holds real-time (non-delayed) quote
entitlement for the markets they trade. Increment 1 of
`plans/uta-broker-futu.md` only implemented `getSecuritySnapshot` — a
request/response pull. Getting the account's real entitlement to actually
show up as live-updating prices requires the `futu-api` SDK's genuine push
protocol, grounded in the bundled `.proto` files:

- `Qot_Sub.proto` (cmd 3001, `ftCmdID.QotSub`): `C2S { securityList,
  subTypeList, isSubOrUnSub, isRegOrUnRegPush, ... }`. Subscribing AND
  registering push are two independent flags on the same call —
  `isSubOrUnSub: true` subscribes the security; `isRegOrUnRegPush: true`
  additionally registers this connection to receive server pushes for it.
  `S2C {}` — the subscribe ack itself carries no quote data.
- `Qot_Common.proto` `enum SubType`: `SubType_Basic = 1` is the subscription
  type for basic quote (last/bid/ask/volume) push — the one this increment
  needs. (Other values exist for order book, ticker, K-line intervals, etc.
  — out of scope here.)
- `Qot_UpdateBasicQot.proto` (cmd 3005, `ftCmdID.QotUpdateBasicQot`):
  `S2C { basicQotList: repeated Qot_Common.BasicQot }` — pushed
  asynchronously, NOT as a Request/Response pair. The `futu-api` SDK's
  `ftWebsocket` already has a push channel: `ws.onPush = (cmd, response) =>
  ...` (confirmed in `main.js`'s `_onPush`), which decodes the pushed
  protobuf using the same `ftCmdID` cmd→name table used for request/response,
  so `cmd === ftCmdID.QotUpdateBasicQot.cmd` (3005) is the filter and
  `response.s2c.basicQotList` is the payload — structurally identical to
  `BasicQot` already typed in `futu-types.ts` for the snapshot path.

## Why this is a 5-layer project, not a FutuBroker-only change

Read in full: `packages/uta-protocol/src/types/broker.ts` (`IBroker`, 621
lines) and `src/domain/market-data/bars/types.ts` (`BarService`). Neither
has ANY push/subscribe primitive today — every method is a one-shot
Promise (`getQuote(contract): Promise<Quote>`, `getBars(...):
Promise<BarsResult>`). `IBroker.setConnectionStateListener` exists but is
scoped to broker-alive/dead/restored transport events, not quote data.

So "wire real push" is new architecture across:

1. **FutuGateway / FutuBroker** (this increment) — subscribe, decode pushes,
   expose them as a capability.
2. **`IBroker` contract** — an optional `subscribeQuote`/`onQuoteUpdate`
   shape other brokers can also adopt later; must not force every existing
   broker to implement it.
3. **UTA HTTP boundary** — `services/uta/src/http/` is REST today; a live
   channel needs a WebSocket or SSE endpoint.
4. **Alice webui** — a relay from UTA's push channel to the browser,
   analogous to the existing Workspace PTY WebSocket pattern.
5. **"Market" UI page** — switch from polling `getQuote` to listening on the
   live channel.

## Decision

Alternatives considered for increment 1's shape:

- **Fast-interval polling** (re-fetch `getQuote` every 1–2s): zero new
  architecture, reuses everything, "looks" live to a human, but is not
  actually push and was explicitly rejected by the maintainer in favor of
  real zero-latency push.
- **Full 5-layer build in one increment**: rejected as too large a single
  change to review/verify; the maintainer explicitly asked to start at
  layer 1 only and proceed layer by layer.

Chosen: build layer 1 (FutuGateway/FutuBroker subscription + push decode)
now, as a capability that does not yet touch `IBroker`, UTA HTTP, Alice
webui, or the UI. It is additive-only on `FutuBroker` (new public method,
not part of the `IBroker` interface it implements), so nothing upstream
breaks or depends on it yet. Increments 2–5 remain unstarted and unscoped
until layer 1 is verified.

## Ordered increments

- [x] **Increment 1 — FutuGateway/FutuBroker subscription (this increment)**
  - `FutuGateway.subscribeBasicQuote(securities, onUpdate): Promise<() =>
    Promise<void>>` — calls `Qot_Sub` with `subTypeList: [SubType_Basic]`,
    `isSubOrUnSub: true`, `isRegOrUnRegPush: true`; wires `onPush` to filter
    `cmd === QotUpdateBasicQot.cmd` and invoke `onUpdate` with decoded
    `BasicQot` rows; returns an unsubscribe closure that re-calls `Qot_Sub`
    with `isSubOrUnSub: false`.
  - `FutuBroker.subscribeQuote(contract, onUpdate): Promise<() => Promise<void>>`
    — resolves the contract to a `Security`, delegates to the gateway,
    maps each pushed `BasicQot` through the same fields as `getQuote`.
    Returns a distinct `FutuBasicQuoteUpdate` shape (last/high/low/open/
    lastClose/volume/turnover/timestamp) rather than `Quote` — `BasicQot`
    carries no bid/ask, so reusing `Quote`'s required bid/ask fields would
    have fabricated data the push never actually delivered.
  - `FutuGatewayClient` reference-counts overlapping subscriptions to the
    same security across multiple callers (e.g. two Market-page widgets
    watching the same symbol) so only the last unsubscribe actually sends
    the wire un-subscribe, and a single `ws.onPush` slot fans pushed rows
    out to every matching subscription — `ftWebsocket.onPush` is a single
    callback property, not a multi-listener emitter, so this fan-out had
    to be built rather than assumed.
  - Unit tests against a fake gateway/fake push emitter — no real FutuOpenD
    connection. `FutuBroker.spec.ts` covers the broker-level mapping (33
    tests total); `FutuGatewayClient.spec.ts` covers the wire-level
    subscribe/fan-out/reference-counted-unsubscribe behavior against a
    mocked `futu-api` module (8 tests). 41/41 pass.
  - `npx tsc --noEmit` (repo root) and `services/uta` typecheck unchanged
    vs. the pre-existing 7-error baseline (zero new errors).
- [ ] **Increment 2 — `IBroker` contract.** Add an optional
  `subscribeQuote?(contract, onUpdate): Promise<() => Promise<void>>` (exact
  shape TBD at increment start) to `packages/uta-protocol/src/types/broker.ts`,
  documented as optional so CCXT/Alpaca/IBKR/Longbridge/Mock are unaffected.
- [ ] **Increment 3 — UTA HTTP boundary.** A WebSocket (or SSE) endpoint
  under `services/uta/src/http/` that a client can open per-contract and
  receive push frames on, backed by `IBroker.subscribeQuote` where
  available; graceful "not supported" for brokers without it.
- [ ] **Increment 4 — Alice webui relay.** Bridge UTA's live channel into
  Alice's own WS/IPC surface (pattern precedent: Workspace PTY WS), scoped
  per open "Market" view rather than always-on for every UTA account.
- [ ] **Increment 5 — "Market" UI page.** Replace/augment the polling
  fetch with a live-channel subscription; visually distinguish a
  push-backed live quote from a polled one (reuse `BarCapability`
  ideas — `'realtime'` push vs `'delayed'`/polled).

## Explicitly out of scope for increment 1

- Any change to `IBroker`, UTA HTTP, Alice webui, or the "Market" page.
- Order-book (`SubType_OrderBook`), ticker (`SubType_Ticker`), or live
  K-line (`SubType_KL_*`) subscriptions — only `SubType_Basic` (last/bid/ask)
  is in scope here.
- Verifying against a real FutuOpenD gateway — still unavailable in this
  environment; unit tests use a fake push emitter.

## Completion criteria for increment 1

`FutuGateway`/`FutuBroker` compile, `subscribeQuote` is unit-tested against
a fake gateway that simulates a `Qot_UpdateBasicQot` push after a successful
`Qot_Sub` ack, unsubscribe correctly stops further callbacks, and
`npx tsc --noEmit` / the targeted `FutuBroker.spec.ts` are green. Increments
2–5 stay unstarted follow-ups recorded in this same plan file until picked
up.

Status: Increment 1 is complete and verified (41/41 targeted unit tests,
clean typecheck vs. baseline). NOT verified against a real FutuOpenD gateway
or Futu account — still unavailable in this environment. Increments 2–5
(the `IBroker` contract, UTA HTTP boundary, Alice webui relay, and "Market"
UI page) remain unstarted; each needs its own scope confirmation before
starting given how much cross-cutting surface they touch.
