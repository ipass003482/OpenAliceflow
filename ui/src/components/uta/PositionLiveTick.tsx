import { useLiveQuote } from '../../hooks/useLiveQuote'
import { LiveQuoteBadge } from '../market/LiveQuoteBadge'

interface Props {
  utaId: string
  aliceId?: string
  /** The polled `marketPrice` to fall back to / to format alongside. */
  formatFallback: (value: string) => string
}

/**
 * Overlays a live-pushed current price next to a position row's polled
 * `marketPrice`, without touching the row's PnL/market-value math (those
 * stay derived from the last polled `getPositions()` read — mixing a
 * live-ticking price into PnL computed from a stale poll would misattribute
 * where the number came from). Renders nothing when the account has no
 * live-quote support or hasn't reported a price yet — the caller's own
 * polled price display remains the only thing shown in that case.
 */
export function PositionLiveTick({ utaId, aliceId, formatFallback }: Props) {
  const live = useLiveQuote(utaId, aliceId ? { aliceId } : undefined)
  if (live.status !== 'live' || !live.quote) return null
  return (
    <span className="inline-flex items-center gap-1 ml-1.5 align-middle">
      <LiveQuoteBadge />
      <span className="font-mono">{formatFallback(live.quote.last)}</span>
    </span>
  )
}
