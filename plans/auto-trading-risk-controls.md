# Auto-trading risk controls

Status: active

Owner guides: [Project structure](../docs/project-structure.md), [UTA live testing](../docs/uta-live-testing.md)

## Scope and decisions

- Enforce automated-order risk at the UTA write boundary so UI, tools, and schedules share one policy.
- Automatic approval is paper/demo-only and account-scoped; real accounts remain manual.
- Use safe defaults with a compact account-level UI, while preserving editable advanced limits.
- Persist emergency-stop, circuit-breaker, cooldown, and rolling order counters under the UTA account state.
- Fail closed when identity, quote freshness, notional, exposure, or loss cannot be established.

## Work

- [x] Add typed per-account automatic-trading policy and paper-mode validation.
- [x] Add mandatory limits: order notional, symbol exposure, daily loss, hourly/daily counts, slippage, quote age, and aliceId allowlist.
- [x] Add persistent global emergency stop and automatic circuit-breaker state.
- [x] Expose the global emergency stop and account-level safe policy controls through the UI.
- [ ] Add unit, integration, and browser-route verification. Root/UI typechecks pass; UTA's full typecheck remains blocked by pre-existing Futu/IBKR spec errors.

## Completion criteria

- No automated push can reach a real-money account.
- Every automated placement is rejected unless all mandatory controls are configured and pass.
- Emergency stop and automatic pause survive restart and are visible/resettable by the user.
- Required repository and touched-surface verification passes; live Futu paper verification remains explicitly gated on a configured FutuOpenD demo account.
