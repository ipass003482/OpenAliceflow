# UTA Broker: Futu (富途) Pack

Status: investigation/grounding complete; implementation not started.

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
- **Increment 2 (deferred, not started)**: order placement/modify/cancel —
  must not be attempted without a real demo/paper Futu account + FutuOpenD
  gateway to verify against (per `docs/uta-live-testing.md`).
- **Increment 3 (deferred, not started)**: register `futu` as a first-class
  `BROKER_ENGINE` (UI broker picker, `broker-packs.md` supported-engine list,
  4-platform release catalog packaging).

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

- [ ] Finish the open TODOs above (proto grounding for BasicQot, Trd_Common,
      InitConnect, KeepAlive; locate `BrokerEngine` / `InstallableBrokerEngine`).
- [ ] `services/uta/src/domain/trading/brokers/futu/futu-contracts.ts` —
      `Security{market,code}` <-> IBKR `Contract` mapping, mirroring
      `longbridge-contracts.ts` (`makeContract`, `resolveSymbol`,
      `echoContractDescription`, market-enum <-> exchange/currency table).
- [ ] `services/uta/src/domain/trading/brokers/futu/futu-types.ts` — hand
      written types for the request/response shapes actually used (no
      upstream `.d.ts` to lean on).
- [ ] `services/uta/src/domain/trading/brokers/futu/FutuGatewayClient.ts` —
      low-level connect/handshake/keepalive/request-response wrapper over
      `futu-api`'s `base.js` socket + `proto.js` protobuf root.
- [ ] `services/uta/src/domain/trading/brokers/futu/FutuBroker.ts` —
      `IBroker` implementation: `init`/`close`, `getAccount`,
      `getPositions`, `getQuote`, `getMarketClock`, `getCapabilities`,
      `getNativeKey`/`resolveNativeKey`, `searchContracts`/
      `getContractDetails` (Futu has no fuzzy-search proto found so far —
      likely an echo-only implementation like Longbridge's fallback, to be
      confirmed once `Qot_GetStaticInfo.proto` is read).
      `placeOrder`/`modifyOrder`/`cancelOrder`/`closePosition` loud-refuse
      with `BrokerError('CONFIG', ...)`.
- [ ] `packages/uta-broker-futu/src/index.ts` — wire the real `FutuBroker`
      (replace the scaffold's dangling import once the class exists).
- [ ] Add `'futu'` to the `BrokerEngine` union (uta-protocol) and
      `InstallableBrokerEngine` (Alice `src/core/broker-packs.ts`); register
      `packages/uta-broker-futu/src/index.ts` in `registry.ts`'s
      `workspaceEntries`.
- [ ] `FutuBroker.spec.ts` — unit tests against **mocked** gateway responses
      (construct fake protobuf-decoded objects directly; do not attempt a
      real socket in tests), mirroring `LongbridgeBroker.spec.ts`'s
      structure.
- [ ] `pnpm -F @traderalice/uta-broker-futu typecheck` and the targeted
      `services/uta` vitest file both green.
- [ ] `npx tsc --noEmit` (repo root) and `pnpm test` (full monorepo) still
      green — confirms the new engine doesn't regress anything else.

## Explicitly out of scope for this plan (do not attempt without a live gateway)

- Any order placement/modification/cancellation logic (Increment 2).
- UI broker-picker entry, `docs/broker-packs.md` supported-engine list
  update, and the 4-platform release-catalog packaging (Increment 3).
- Any claim of live-paper verification — there is no FutuOpenD gateway or
  Futu account available to this session.

## Completion criteria for Increment 1

`FutuBroker` compiles, its read-only methods are unit-tested against mocked
gateway responses, `futu` is a recognized `BROKER_ENGINE` loadable via the
dev-only workspace-pack path (`OPENALICE_BROKER_PACK_ALLOW_WORKSPACE=1` /
`NODE_ENV=test`), and this plan file is deleted with its checklist fully
checked off (or split forward into Increment 2/3 follow-up plans) per the
Plan Contract in `PLANS.md`.
