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

### Target surface decision (recorded after increment 1)

`ui/src/components/market/QuoteHeader.tsx` (the "Market" page's per-symbol
quote header) carries an explicit comment: "Bid / ask intentionally
omitted — they're real-time L1 quote data that belongs at the execution
layer (UTA), not in analysis." That boundary put broker L1 quotes only on
`UTADetailPage.tsx` (the account/positions surface), never on the
vendor-fed "Market" research page.

The maintainer explicitly asked for BOTH surfaces to be live and accepted
overriding that boundary comment. Recorded choice for increment 5: keep
`UTADetailPage`'s position mark price as the primary, architecturally
natural consumer of the live push; additionally layer a live-quote overlay
onto the Market page's `QuoteHeader`/`EquityDetail` — shown only when the
viewed symbol resolves to a connected UTA account that supports
`subscribeQuote` — rather than ripping out the vendor-quote fallback
entirely (a symbol with no matching broker account still needs the
existing 60s-polled vendor quote). This is a deliberate, recorded departure
from the prior design intent, not a silent regression.

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
- [x] **Increment 2 — `IBroker` contract.** Added `QuoteUpdate` (contract,
  last, timestamp required; bid/ask/volume/high/low optional — a push
  channel may not carry all of them) and an optional
  `subscribeQuote?(contract, onUpdate): Promise<() => Promise<void>>` to
  `packages/uta-protocol/src/types/broker.ts`. `FutuBroker`'s existing
  `subscribeQuote` (typed with the richer `FutuBasicQuoteUpdate`) satisfies
  this optional method structurally — TS method-shorthand bivariance means
  no change to `FutuBroker.ts` was needed. Added a mirror
  `UnifiedTradingAccount.subscribeQuote` (aliceId expansion + contract
  stamping, same pattern as `getQuote`) and a `supportsLiveQuote` getter so
  callers can branch instead of catching. 5 new unit tests
  (`UnifiedTradingAccount.spec.ts`); full file 118/118 pass; other brokers'
  specs (Longbridge, registry, Mock) unaffected — optional methods can't
  break an existing `implements IBroker`.
- [x] **Increment 3 — UTA HTTP boundary.** `GET /uta/:id/quote-stream` in
  `services/uta/src/http/routes-trading.ts` using `streamSSE` from
  `hono/streaming` (no prior live route to copy — the `chat.ts` SSE
  precedent implied by an old test comment no longer exists, per the World-B
  in-process-AI-loop removal). `EventSource` is GET-only, so the contract
  travels as `?symbol=` or `?aliceId=` query params, unlike the existing
  POST `/uta/:id/quote`. Returns 404 (unknown account), 501 (broker has no
  `subscribeQuote` — never silently falls back to polling on the caller's
  behalf) or 400 (missing symbol/aliceId) before opening the stream;
  pushes `event: quote` frames, or one `event: error` frame if the initial
  `subscribeQuote` call itself throws (e.g. "not entitled for real-time
  quotes"). `stream.onAbort` releases the broker-side subscription on
  client disconnect. 6 new tests in
  `routes-trading-quote-stream.spec.ts`; full `services/uta/src/http/`
  suite 35/35 pass.
- [x] **Increment 4 — Alice webui relay.** No code change needed:
  `src/webui/routes/trading-proxy.ts`'s existing transparent passthrough
  (`return new Response(upstream.body, { status, statusText, headers })`)
  already forwards a chunked SSE body end-to-end — its own doc comment
  already claimed this ("SSE headers pass through"), and a new integration
  test in `trading-proxy.spec.ts` now proves it against a real streaming
  `ReadableStream` upstream (not just buffered JSON like the file's other
  tests), confirming the claim instead of trusting it. 13/13 pass.
- [ ] **Increment 5 — UI.** Per the maintainer's explicit decision (see
  "Target surface decision" above), wire a live-quote hook into BOTH
  `UTADetailPage.tsx` (position mark price — the architecturally natural
  consumer) AND the Market page's `QuoteHeader.tsx`/`EquityDetail.tsx`
  (overlaying the vendor-polled quote when the viewed symbol resolves to a
  connected UTA account with `subscribeQuote` support), overriding that
  file's prior "bid/ask belongs to execution layer" boundary comment.
  Needs its own design pass (EventSource client hook shape, symbol→UTA
  resolution reusing the existing `contracts/search` bridge, visual "live"
  vs "delayed" distinction) before writing frontend code — not started.

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
