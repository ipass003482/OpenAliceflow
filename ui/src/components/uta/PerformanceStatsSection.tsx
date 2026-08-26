import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '../ui/button'
import { Skeleton } from '../StateViews'
import { fmt, fmtPnl } from '../../lib/format'
import type { TradeStatsState } from '../../hooks/useTradeStats'

function valueOrDash(value: string | null, formatter: (value: string) => string): string {
  return value == null ? '—' : formatter(value)
}

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-secondary/45 px-3.5 py-3">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</dd>
      {detail && <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{detail}</p>}
    </div>
  )
}

export function PerformanceStatsSection({ state, currency }: { state: TradeStatsState; currency: string }) {
  const [expanded, setExpanded] = useState(true)
  const panelId = 'uta-performance-stats-panel'

  return (
    <section aria-labelledby="uta-performance-stats-heading">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 id="uta-performance-stats-heading" className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          績效統計 <span className="normal-case font-normal">/ Performance</span>
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收合' : '展開'}
          <ChevronDown className={expanded ? 'rotate-180' : ''} aria-hidden />
        </Button>
      </div>

      {expanded && (
        <div id={panelId} className="rounded-lg border border-border p-3 md:p-4">
          {state.status === 'loading' ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading performance statistics">
              {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-24 rounded-lg" />)}
            </div>
          ) : state.stats.closedCount === 0 ? (
            <div className="rounded-lg bg-muted/35 px-4 py-6 text-center">
              <p className="text-[13px] font-medium text-foreground">尚無已平倉交易</p>
              <p className="mt-1 text-[11px] text-muted-foreground">完成一組可配對的買賣成交後，這裡會顯示扣除已知費用的績效。</p>
            </div>
          ) : (() => {
            const stats = state.stats
            const pnlCurrency = currency || 'USD'
            const feeCurrency = stats.feeCurrency ?? pnlCurrency
            const slippageCurrency = stats.slippageCurrency ?? pnlCurrency
            return (
              <>
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <StatTile label="勝率 / Win rate" value={`${stats.winRate ?? '0'}%`} detail={`${stats.winningCount} / ${stats.closedCount} round trips`} />
                  <StatTile label="獲利因子 / Profit factor" value={stats.profitFactor === 'Infinity' ? '∞' : stats.profitFactor ?? '—'} />
                  <StatTile label="期望值 / Expectancy" value={valueOrDash(stats.expectancy, (value) => fmtPnl(value, pnlCurrency))} detail="每組已平倉交易，扣除已知費用" />
                  <StatTile label="最大回撤 / Max drawdown" value={valueOrDash(stats.maxDrawdown, (value) => fmt(value, pnlCurrency))} detail={stats.maxDrawdownPct == null ? undefined : `${stats.maxDrawdownPct}% peak-to-trough`} />
                  <StatTile label="費用 / Total fees" value={fmt(stats.totalFees, feeCurrency)} detail={`fees known for ${stats.feeKnownOrders} of ${stats.feeRelevantOrders} orders`} />
                  <StatTile
                    label="滑價 / Slippage"
                    value={valueOrDash(stats.slippage, (value) => fmt(value, slippageCurrency))}
                    detail={`${stats.slippageTrackedOrders} limit tracked · ${stats.slippageUntrackedMarketOrders} market untracked`}
                  />
                </dl>
                {stats.feeKnownOrders < stats.feeRelevantOrders && (
                  <p className="mt-3 text-[11px] text-muted-foreground" role="note">
                    費用資料不完整：統計只扣除帳本已記錄的費用，未將缺失值假設為 0。
                  </p>
                )}
              </>
            )
          })()}
        </div>
      )}
    </section>
  )
}
