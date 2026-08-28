# Yuanta SPARK UAT Broker Pack

Status: active

Related owner guides: [Broker Packs](../docs/broker-packs.md),
[UTA live testing](../docs/uta-live-testing.md),
[Development workflow](../docs/development-workflow.md)

## Goal

Add a portable Yuanta SPARK broker integration for Taiwan-equity testing. A
fresh OpenAlice checkout or release on another supported computer must be able
to install the OpenAlice-owned Broker Pack and Bridge, fetch the vendor runtime
from Yuanta's official distribution after explicit license consent, and guide
the user through the external UAT prerequisites without repository-local DLLs,
credentials, certificates, or absolute paths.

The first release is UAT-only. It must have no configuration or code path that
can select SPARK PROD.

## Product design decision

Three interaction models were considered:

1. Add Yuanta to the existing Add UTA broker picker.
2. Add one global Futu/Yuanta switch.
3. Build a separate Yuanta setup page.

Choose (1). It preserves OpenAlice's multi-UTA model, lets Futu and Yuanta
accounts coexist, and reuses the existing pack install/test/save flow. The
Yuanta option is labelled as UAT on the picker, form, account card, health
surface, and order confirmation. The form remains keyboard/focus compatible
with the shared dialog and schema-field primitives. Narrow layouts keep the
existing single-column dialog behavior.

## Distribution and security decisions

- OpenAlice-owned TypeScript/C# source and release automation are tracked.
- Yuanta binaries and the public UAT certificate are not tracked or silently
  redistributed. The installer downloads the version-pinned official archive
  only after explicit vendor-license consent, verifies its SHA-256 and extracts
  it into replaceable runtime state.
- Account passwords remain write-only secrets and must not appear in config
  responses, logs, manifests, command lines, test fixtures, or Git history.
- The UAT preset hardcodes the SPARK `UAT` environment. PROD is out of scope.
- Missing .NET 8, certificate installation, API permission, fixed-public-IP
  allowlisting, and firewall rejection are reported as actionable health
  states. OpenAlice does not bypass those vendor controls.

## Ordered work

- [x] Record the official artifact URL, size, SHA-256, supported platforms, and
      vendor-license consent metadata in a versioned Yuanta runtime manifest.
- [x] Add a Yuanta installable engine, UAT-only preset, broker-pack catalog
      integration, install/repair behavior, and UI/demo/tests.
- [ ] Add an OpenAlice-owned .NET 8 Bridge with a local authenticated IPC
      protocol, lifecycle supervision, secret-safe logging, and deterministic
      fake-server tests.
- [ ] Implement UAT login/health, TWSE/TPEx contract identity, quote/K-line,
      account, positions, order/trade listing, place, modify, and cancel maps.
- [ ] Model Taiwan whole-share/intraday-odd-lot quantities, price flags,
      ROD/IOC/FOK, tick-size validation, and loud refusal for unsupported
      financing/short/after-hours/derivative paths.
- [ ] Verify `npx tsc --noEmit`, `pnpm test`, protocol/package typechecks, UI
      typecheck and demo route, non-trading E2E, Broker Pack build/install, and
      a clean-machine unsigned package smoke.
- [ ] After the maintainer confirms a Yuanta-approved fixed IP and imported UAT
      certificate, run the smallest UAT account lifecycle, record venue truth,
      cancel all new orders, and restore the account baseline.

## Completion criteria

- A second computer can clone/build or install OpenAlice, select Yuanta SPARK
  UAT, accept the vendor download, and reach a precise Ready/Blocked health
  state without manually copying repository-external program files.
- With Yuanta prerequisites satisfied, the UAT lifecycle is verified through
  OpenAlice's agent/UI surfaces and no PROD order can be emitted.
- Futu and Yuanta UTAs can coexist and orders remain explicitly account-routed.
