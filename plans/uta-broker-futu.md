# UTA Broker: Futu (富途) Pack

Status: Increments 1–3 (read-only broker, order writes, first-class engine
registration) all complete at the code/unit-test level. Never verified
against a real FutuOpenD gateway or Futu account.

Related owner guides: [[docs/broker-packs.md]], [[docs/uta-live-testing.md]],
[[docs/ibkr-wire-protocol.md]] (closest precedent for wire-protocol complexity).

## Origin

Found as an uncommitted, never-finished scaffold on a stale local branch
(`feature/uta-broker-futu`, based on an old `dev` commit). The scaffold had
`packages/uta-broker-futu/package.json`, `tsconfig.json`, `tsup.config.ts`,
and a one-line `src/index.ts` that imported a `FutuBroker` class that was
never created under `services/uta/src/domain/trading/brokers/futu/`. No
commit in git history ever referenced it. The scaffold work was carried
forward onto a fresh branch `feat/uta-broker-futu` cut from current `dev`.

## Scope decision (why this is smaller than "just copy longbridge")

`docs/broker-packs.md` line 38 lists the currently supported
`BROKER_ENGINE` union as `'ccxt' | 'alpaca' | 'ibkr' | 'leverup' |
'longbridge'` — Futu is not yet a recognized engine anywhere in the type
system, registry, UI, or release catalog.

Unlike `longbridge` (a typed, friendly `TradeContext`/`QuoteContext` SDK) or
`ibkr` (already has its own owner guide + dedicated `packages/ibkr` wire
package), the `futu-api` npm package is a **raw protobuf socket SDK**:

- No TypeScript type definitions at all (`main.js`/`base.js`/`proto.js` only).
- 182 `.proto` files bundled (22 are `Trd_*` trading messages).
- Requires a locally running, separately-installed, separately-logged-in
  **FutuOpenD gateway** process on the same machine — the wire protocol is a
  TCP/WS socket to that gateway, not a direct cloud REST/WS call. This is the
  same order of complexity as the IBKR TWS/Gateway wire protocol.
- No live FutuOpenD gateway or Futu account is available in this environment,
  so nothing here can be verified end-to-end. Per repo convention
  ("寧可空白，不可捏造" / fact-check-before-code), only proto-file-grounded
  facts are used below; anything not confirmed against the `.proto` sources
  is left as an open TODO rather than guessed.

Agreed increment split:

- **Increment 1 (this plan's active scope)**: read-only `FutuBroker` —
  account funds, positions, quotes, market clock, capabilities, native-key
  round-trip. `placeOrder`/`modifyOrder`/`cancelOrder`/`closePosition` are
  still required by `IBroker`, so they exist but loud-refuse with
  `BrokerError('CONFIG', 'Futu order writes are not supported yet')`.
  Verification ceiling: `tsc --noEmit` + unit tests against **mocked** gateway
  responses. No real or simulated FutuOpenD connection is exercised.
- **Increment 2 (complete — see "Increment 2" section below)**: order
  placement/modify/cancel/close. The maintainer explicitly requested this
  before any live FutuOpenD/account verification was available — same
  standing exception already exercised for Increment 1 and for the whole
  `plans/futu-realtime-quotes.md` project. Verification ceiling is
  identical: `tsc --noEmit` + unit tests against a **mocked** gateway. NOT
  verified against a real FutuOpenD gateway or Futu account.
- **Increment 3 (complete — see "Increment 3" section below)**: register
  `futu` as a first-class `BROKER_ENGINE`. The backend half (registry,
  `INSTALLABLE_BROKER_ENGINES`, `docs/broker-packs.md`'s engine union, the
  4-platform release-catalog build script's `packageNames` map) was already
  done as part of Increment 1's commit. What remained — and is now done —
  was the UI-facing half: a `FUTU_PRESET` in the broker-preset catalog and
  the frontend `BrokerEngine`/`BrokerPreset.engine` type union, without
  which Futu could not actually be added through the Trading page wizard.

## Grounded facts (from the bundled `.proto` files — do not re-derive, reuse)

Source: `packages/uta-broker-futu/node_modules/futu-api/proto/*.proto` (npm
package already installed under the scaffold's `node_modules`).

- `Qot_Common.proto`:
  - `enum QotMarket`: `HK_Security=1`, `US_Security=11`, `CNSH_Security=21`
    (Shanghai), `CNSZ_Security=22` (Shenzhen), `SG_Security=31`,
    `JP_Security=41`, `AU_Security=51`, `MY_Security=61`, `CA_Security=71`,
    `FX_Security=81`, `CC_Security=91` (crypto).
  - `message Security { required int32 market = 1; required string code = 2; }`
    — a security is identified by a **separate market enum int + code
    string**, NOT a single `"HK.00700"`-style string on the wire (that
    format is only a docs/display convention). Any contract round-trip
    helper (mirroring `longbridge-contracts.ts`) must carry both fields.
  - `enum SecurityType`: `Eqty=3` (equity), `Warrant=5`, `Index=6`,
    `Drvt=8` (option), `Future=10`, `Forex=11`, `Crypto=12`, etc.
- `Qot_GetBasicQot.proto` (quote fetch, cmd 3004 per `main.js` `ftCmdID`):
  - `Request.c2s = { securityList: repeated Qot_Common.Security, header }`
  - `Response.s2c = { basicQotList: repeated Qot_Common.BasicQot }`
  - `BasicQot` field shapes were not yet read — **open TODO**, see below.
- `main.js` exports `ftCmdID`, a full table mapping every proto's `cmd`
  number → `{ name, description }` (e.g. `InitConnect=1001`,
  `GetGlobalState=1002` — note: table shows `GetGlobalState` for cmd 1002
  which also duplicates the InitConnect display name at 1001; re-check this
  when wiring the actual encode/decode path), `KeepAlive=1004`,
  `QotGetBasicQot=3004`.
  Trading cmd ids were not yet read — **open TODO**.

## Open TODOs before Increment 1 code can be written (not started)

1. Read `Qot_Common.proto` `message BasicQot { ... }` for exact quote fields
   (last/bid/ask/volume/high/low/timestamp — map onto protocol `Quote`).
2. Read `Trd_Common.proto` for `TrdEnv` (real/simulate) and `TrdMarket`
   (HK/US/CN) enums, plus the `Position`/`Order`/`Funds` message shapes used
   by `Trd_GetFunds.proto`, `Trd_GetPositionList.proto`,
   `Trd_GetAccList.proto`.
3. Read `InitConnect.proto` and `KeepAlive.proto` for the handshake/heartbeat
   contract (Futu's `InitConnect` includes an RSA/AES key-exchange step per
   published docs — confirm the exact fields before implementing, don't
   assume).
4. Read `base.js` (`ftWebsocketBase`, `services/uta` equivalent of
   `longbridge`'s already-built transport) for the actual packet framing
   (header layout, protobuf body encode/decode, sequence-number
   request/response correlation) so a `FutuGatewayClient` wraps it instead
   of reimplementing socket framing from scratch.
5. Confirm where `BrokerEngine` (the type union consumed by
   `services/uta/src/domain/trading/brokers/registry.ts`) is actually
   defined inside `@traderalice/uta-protocol` — not yet located in this
   session; needed before adding `'futu'` to the union.
6. Confirm `InstallableBrokerEngine` in `src/core/broker-packs.ts` (Alice
   side) — same "not yet located" note; needed for
   `registry.ts`'s `workspaceEntries` map and `isInstallableBrokerEngine`.

## Ordered implementation checklist (Increment 1)

- [x] Finish the open TODOs above (proto grounding for BasicQot, Trd_Common,
      InitConnect, KeepAlive; locate `BrokerEngine` / `InstallableBrokerEngine`).
- [x] `services/uta/src/domain/trading/brokers/futu/futu-contracts.ts` —
      `Security{market,code}` <-> IBKR `Contract` mapping, mirroring
      `longbridge-contracts.ts` (`makeContract`, `resolveSymbol`,
      `echoContractDescription`, market-enum <-> exchange/currency table).
- [x] `services/uta/src/domain/trading/brokers/futu/futu-types.ts` — hand
      written types for the request/response shapes actually used (no
      upstream `.d.ts` to lean on).
- [x] `services/uta/src/domain/trading/brokers/futu/FutuGatewayClient.ts` —
      low-level connect/handshake/keepalive/request-response wrapper over
      `futu-api`'s `base.js` socket + `proto.js` protobuf root.
- [x] `services/uta/src/domain/trading/brokers/futu/FutuBroker.ts` —
      `IBroker` implementation: `init`/`close`, `getAccount`,
      `getPositions`, `getQuote`, `getMarketClock`, `getCapabilities`,
      `getNativeKey`/`resolveNativeKey`, `searchContracts`/
      `getContractDetails` (Futu has no fuzzy-search proto found so far —
      likely an echo-only implementation like Longbridge's fallback, to be
      confirmed once `Qot_GetStaticInfo.proto` is read).
      `placeOrder`/`modifyOrder`/`cancelOrder`/`closePosition` loud-refuse
      with `BrokerError('CONFIG', ...)`.
- [x] `packages/uta-broker-futu/src/index.ts` — wire the real `FutuBroker`
      (replace the scaffold's dangling import once the class exists).
- [x] Add `'futu'` to the `BrokerEngine` union (uta-protocol) and
      `InstallableBrokerEngine` (Alice `src/core/broker-packs.ts`); register
      `packages/uta-broker-futu/src/index.ts` in `registry.ts`'s
      `workspaceEntries`.
- [x] `FutuBroker.spec.ts` — unit tests against **mocked** gateway responses
      (construct fake protobuf-decoded objects directly; do not attempt a
      real socket in tests), mirroring `LongbridgeBroker.spec.ts`'s
      structure. 29/29 pass.
- [x] `pnpm -F @traderalice/uta-broker-futu typecheck` and the targeted
      `services/uta` vitest file both green.
- [x] `npx tsc --noEmit` (repo root, uta-protocol, services/uta) green and
      unchanged vs. the pre-existing baseline. Full-suite `pnpm test` is not
      reliable on this development machine (vitest forked-worker pool
      exhaustion running node+ui projects together under a slow encrypted
      filesystem — confirmed present on a clean `dev` checkout with this
      change fully stashed away, not caused by this change). Verification
      instead ran the targeted specs with a raised timeout:
      `presets.spec.ts` (57/58 — the one remaining failure is a pre-existing
      `longbridge` native-binding load error, also reproduced on clean
      `dev`), `registry.spec.ts` (7/7), `keyless-data-uta.spec.ts` (8/8),
      `FutuBroker.spec.ts` (29/29).

## Explicitly out of scope for this plan (do not attempt without a live gateway)

- Combo orders, TWAP/VWAP, trailing-stop orders, and bracket take-profit/
  stop-loss legs (Increment 2 handles single-leg MKT/LMT/STP/STP LMT only —
  see "Increment 2" below for the exact refusal behavior).
- Any claim of live-paper verification — there is no FutuOpenD gateway or
  Futu account available to this session, for either Increment 1 or 2.

## Increment 2 — order placement/modify/cancel/close

Scope, grounded in the same bundled `.proto` files as Increment 1
(`Trd_PlaceOrder.proto`, `Trd_ModifyOrder.proto`, `Trd_UnlockTrade.proto`,
`Trd_GetOrderList.proto`, `Trd_Common.proto`'s `TrdSide`/`OrderType`/
`OrderStatus`/`ModifyOrderOp`/`Order` message):

- `placeOrder`/`modifyOrder`/`cancelOrder`/`closePosition`/`getOrders`/
  `getOrder` are implemented for real. `getCapabilities().supportedOrderTypes`
  changed from `[]` to `['MKT', 'LMT', 'STP', 'STP LMT']`.
- **Trade unlock** (`Trd_UnlockTrade`) is required before FutuOpenD accepts
  any order write, and is a one-time-per-OpenD-session unlock, not per-order
  (per the SDK's own doc comment: "解锁，针对OpenD解锁一次即可"). The
  maintainer chose, when asked directly, to let OpenAlice hold the trade
  password (as an optional `tradePassword` config field, same storage as any
  other broker's API secret — masked as a password field in the UI via
  `writeOnlyFields`) and unlock automatically at `init()`, rather than
  requiring a manual unlock inside FutuOpenD every session. The plaintext
  password never reaches disk or the wire: `FutuBroker.init()` MD5-hashes it
  locally (`node:crypto`) before calling `unlockTrade(pwdMD5)`, matching the
  wire format `Trd_UnlockTrade.C2S.pwdMD5` expects. It is never committed to
  git — this is ordinary runtime broker config, not source. Leaving the
  field blank is fully supported: the user can unlock manually inside
  FutuOpenD/moomoo instead, and unlock failure is non-fatal (logged, not
  thrown) so reads keep working — only a later order write actually fails.
- Order-type mapping is deliberately narrow: `MKT`/`LMT`/`STP`/`STP LMT`
  only. TWAP/VWAP, combo, and event-contract order types in
  `Trd_Common.OrderType` are not mapped. Bracket TP/SL (`TpSlParams`) is
  explicitly refused with a clear error rather than silently dropped or
  approximated — Futu's combo-order path (`Trd_PlaceComboOrder.proto`) is a
  structurally different message this increment does not touch.
- `closePosition` looks up the live position and places an opposite-side
  `MKT` order for the (possibly partial) quantity — same pattern as
  `AlpacaBroker.closePosition`'s reverse-order path.
- `getOrders`/`getOrder` map `Trd_Common.Order` rows into IBKR-shaped
  `Order`/`OrderState`, reusing `AlpacaBroker`/`alpaca-contracts.ts`'s
  established `OrderState.status` vocabulary (`Submitted`/`Filled`/
  `Cancelled`/`PendingSubmit`/`PreSubmitted`/`PendingCancel`/`Inactive`/
  `ApiCancelled`) so the ledger/sync layer sees one consistent vocabulary
  regardless of broker. Futu's `orderID` is `uint64` — like Alpaca's UUID
  ids, `Order.orderId` (IBKR's numeric field) is left at its default `0`;
  the real id lives in `OpenOrder.orderId` as a string.
- Verification ceiling — same as every other increment in this plan:
  `npx tsc --noEmit` (root) clean, `FutuBroker.spec.ts` (50 tests) and
  `FutuGatewayClient.spec.ts` (13 tests) green against a **mocked** gateway,
  plus the `BROKER_PRESET_CATALOG` roundtrip test's new `futu` case (verifies
  `FUTU_PRESET.toEngineConfig(...)` output parses against the real
  `FutuBroker.configSchema`). **NOT verified against a real FutuOpenD
  gateway or Futu account.** Start on `trdEnv: 'simulate'` (the config
  default) and confirm behavior there — including that the account stays in
  the expected state — before ever configuring `trdEnv: 'real'`.

### Increment 2 follow-up hardening (maintainer-directed)

Three gaps identified in a post-implementation self-review, each fixed on
maintainer request:

- **1-month order-history window.** `Trd_GetOrderList` only covers TODAY, so
  the original `getOrders`/`getOrder` lost track of any overnight GTC order.
  Lookup is now three-tier, stopping at the first tier that resolves every
  requested id: (1) the push-fresh order cache, (2) today's
  `Trd_GetOrderList`, (3) `Trd_GetHistoryOrderList` over the past 30 days
  (`ORDER_HISTORY_LOOKBACK_DAYS` — one month per the maintainer's explicit
  choice), narrowed via `TrdFilterConditions.idList` and using the strict
  `YYYY-MM-DD HH:MM:SS` time format the proto requires (local machine time —
  the proto documents no timezone and OpenD runs on the same machine).
- **Order-update push.** `Trd_SubAccPush` (cmd 2008) registers the connection
  for `Trd_UpdateOrder` pushes (cmd 2208); `FutuBroker` keeps a
  push-fresh `orderCache` so tracked-order reads stop hitting the wire.
  Registration failure is non-fatal (polling still works); the cache is
  cleared on any transport interruption because pushes missed while
  disconnected would otherwise leave silently stale entries.
- **Connection-state notification.** The `futu-api` base transport
  auto-reconnects a dropped socket on its own (base.js `reconnect()`) and
  re-fires `onlogin(true)` after the re-handshake — but all wire
  subscriptions die with the old socket, and the wrapper class exposes no
  close hook. `FutuGatewayClient` now attaches to the base's
  `onclose` user hook (`ws.websock.onclose`), emits `dead` on unexpected
  close (mapped to `IBroker.setConnectionStateListener`, which
  `UnifiedTradingAccount` already consumes: dead → offline + recovery), and
  after an SDK auto-reconnect re-subscribes every quote security and the
  order-push registration before emitting `restored`. `FutuBroker` re-runs
  trade unlock on `restored` (OpenD itself may have restarted, which wipes
  unlock state; re-unlock is idempotent). A re-run of `init()` now also
  stops the previous gateway first — the UTA recovery loop re-inits without
  closing, and the SDK's auto-reconnect would otherwise keep a zombie
  connection alive.

Verification: `FutuBroker.spec.ts` + `FutuGatewayClient.spec.ts` now total
78 tests, all green against mocked gateways/SDK; root `npx tsc --noEmit`
clean. Same NOT-live-verified ceiling as the rest of this plan.

## Increment 3 — first-class `BROKER_ENGINE` registration

The backend half of this was already done as part of Increment 1's commit:
`'futu'` in `INSTALLABLE_BROKER_ENGINES` (`src/core/broker-packs.ts`), the
`BrokerEngine` union in `packages/uta-protocol/src/brokers/preset-catalog.ts`,
`docs/broker-packs.md`'s documented `BROKER_ENGINE` union, and
`scripts/build-broker-packs.ts`'s `packageNames` map (so `futu` already
gets a 4-platform release archive built alongside the other engines).

What was still missing — discovered while scoping Increment 2, since without
it there was no way to actually add a Futu account through the app — was the
UI-facing half:

- `FUTU_PRESET` added to `BROKER_PRESET_CATALOG`
  (`packages/uta-protocol/src/brokers/preset-catalog.ts`), mirroring the
  `IBKR_PRESET` shape (local-gateway host/port, not cloud API keys):
  `host`/`port`/`ssl`/`wsKey`/`tradePassword`/`trdMarket`/`accID` fields,
  `mode` (simulate/real) drives `isPaper`, `wsKey`/`tradePassword` are
  `writeOnlyFields`.
- `'futu'` added to the frontend `BrokerPreset.engine`/`BrokerEngine` union
  in `ui/src/api/types.ts` — this was the actual gap behind "why can't I add
  Futu from the UI even though the backend engine exists": the generic
  schema-driven form system (`useSchemaForm.ts`/`SchemaFormFields.tsx`) only
  needed the preset + type union to render a working "Add Futu" flow; no
  broker-specific frontend component was needed.

Verification: the `BROKER_PRESET_CATALOG` roundtrip test in
`services/uta/src/domain/trading/brokers/presets.spec.ts` (parameterized
over every preset) now covers `futu` too — confirms the preset's
`zodSchema` accepts a sample config and `toEngineConfig(...)` output parses
against the real `FutuBroker.configSchema`. `cd ui && npx tsc -b` clean.

## Completion criteria for Increment 1

`FutuBroker` compiles, its read-only methods are unit-tested against mocked
gateway responses, `futu` is a recognized `BROKER_ENGINE` loadable via the
dev-only workspace-pack path (`OPENALICE_BROKER_PACK_ALLOW_WORKSPACE=1` /
`NODE_ENV=test`), and this plan file is deleted with its checklist fully
checked off (or split forward into Increment 2/3 follow-up plans) per the
Plan Contract in `PLANS.md`.

Status: Increments 1, 2, and 3 are all complete and verified at the
code/unit-test/typecheck level described above. What remains before this
plan can be deleted is a maintainer decision on accepting the whole pack
(read + write) as-is versus requiring a live-gateway/live-account smoke pass
first — no increment in this plan has ever been exercised against a real
FutuOpenD gateway or Futu account, because neither is available in this
development environment. If accepted as unverified, delete this plan file;
if a live-gateway acceptance pass is required, keep this plan open with that
as the single remaining checklist item.
