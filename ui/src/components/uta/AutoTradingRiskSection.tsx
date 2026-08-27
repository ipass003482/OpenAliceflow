import { Section, Field, inputClass } from '../form'
import { Toggle } from '../Toggle'
import type { UTAConfig } from '../../api/types'

type Policy = NonNullable<UTAConfig['autoTrading']>

const DEFAULT_POLICY: Policy = {
  enabled: false,
  maxOrderNotional: 1_000,
  maxSymbolExposurePercent: 5,
  maxDailyLoss: 500,
  maxOrdersPerHour: 5,
  maxOrdersPerDay: 20,
  maxSlippageBps: 25,
  maxQuoteAgeMs: 5_000,
  allowedAliceIds: [],
  pauseAfterConsecutiveErrors: 3,
}

const numberFields: Array<{ key: Exclude<keyof Policy, 'enabled' | 'allowedAliceIds'>; label: string; hint: string; min: number }> = [
  { key: 'maxOrderNotional', label: 'Maximum order amount', hint: 'Maximum value of one automated order in account currency.', min: 0.01 },
  { key: 'maxSymbolExposurePercent', label: 'Maximum symbol exposure (%)', hint: 'Position plus the new order cannot exceed this share of equity.', min: 0.01 },
  { key: 'maxDailyLoss', label: 'Daily loss limit', hint: 'Automatic entries pause when today’s loss reaches this amount.', min: 0.01 },
  { key: 'maxOrdersPerHour', label: 'Orders per hour', hint: 'Maximum automated entries in a rolling hour.', min: 1 },
  { key: 'maxOrdersPerDay', label: 'Orders per day', hint: 'Maximum automated entries in a trading day.', min: 1 },
  { key: 'maxSlippageBps', label: 'Maximum slippage (bps)', hint: 'Limit order price may not be worse than the current bid/ask by more than this value.', min: 0.01 },
  { key: 'maxQuoteAgeMs', label: 'Maximum quote age (ms)', hint: 'Orders are refused if the quote is older than this.', min: 1 },
  { key: 'pauseAfterConsecutiveErrors', label: 'Circuit breaker errors', hint: 'Consecutive rejected automated pushes before the account pauses.', min: 1 },
]

export function AutoTradingRiskSection({ value, onChange }: {
  value: UTAConfig['autoTrading']
  onChange: (policy: Policy) => void
}) {
  const policy = value ?? DEFAULT_POLICY
  const update = (patch: Partial<Policy>) => onChange({ ...policy, ...patch })

  return (
    <Section title="Automatic trading safety">
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-foreground">Enable automatic execution for this account</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              Paper/demo accounts only. UTA independently rejects live accounts, market orders, missing identity, stale quotes, and any failed limit.
            </p>
          </div>
          <Toggle ariaLabel="Enable automatic execution for this account" checked={policy.enabled} onChange={(enabled) => update({ enabled })} />
        </div>
      </div>

      <div className={`mt-4 space-y-3 ${policy.enabled ? '' : 'opacity-55'}`}>
        <Field label="Allowed product aliceIds">
          <textarea
            className={`${inputClass} min-h-20 font-mono text-[11px]`}
            disabled={!policy.enabled}
            placeholder="futu-account|US.AAPL&#10;futu-account|HK.00700"
            value={policy.allowedAliceIds.join('\n')}
            onChange={(event) => update({ allowedAliceIds: event.target.value.split(/\r?\n|,/).map((id) => id.trim()).filter(Boolean) })}
          />
          <p className="mt-1 text-[10px] text-muted-foreground/60">One exact aliceId per line. Empty lists are refused when automatic execution is enabled.</p>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          {numberFields.map(({ key, label, hint, min }) => (
            <Field key={key} label={label}>
              <input
                className={inputClass}
                disabled={!policy.enabled}
                type="number"
                min={min}
                step={Number.isInteger(min) ? 1 : 'any'}
                value={policy[key]}
                onChange={(event) => update({ [key]: Number(event.target.value) } as Partial<Policy>)}
              />
              <p className="mt-1 text-[10px] text-muted-foreground/60">{hint}</p>
            </Field>
          ))}
        </div>
      </div>
    </Section>
  )
}
