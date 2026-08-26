import { useEffect, useState } from 'react'
import { tradingApi } from '../api/trading'
import { getLiveQuoteCapabilities } from '../live/live-quotes'
import { useLiveQuote } from './useLiveQuote'
import type { LiveQuoteState } from '../live/live-quotes'

/**
 * Resolves a data-vendor symbol (e.g. "AAPL" from the Market page) to a
 * live-quote-capable UTA account, then subscribes if one exists.
 *
 * Reuses the same broker-side fuzzy search the "tradeable contracts" hint
 * card already runs (`tradingApi.searchContracts`) rather than inventing a
 * second symbol→account bridge — this makes an independent search call
 * (accepted duplication; see plans/futu-realtime-quotes.md's Increment 5
 * design notes) but shares zero mutable state with that sibling panel,
 * which keeps this hook simple to reason about on its own.
 *
 * Returns `status: 'connecting'` while resolving, then whatever
 * `useLiveQuote` reports once (if) a matching account is found —
 * `'unsupported'` (no configured account supports live quotes for this
 * symbol) is the common case and callers should keep showing their
 * existing vendor-polled quote in that state.
 */
export function useTradeableLiveQuote(symbol: string, assetClass: 'equity' | 'crypto' | 'currency' | 'commodity'): LiveQuoteState {
  const [resolved, setResolved] = useState<{ utaId: string; aliceId: string } | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setResolved(undefined)
    Promise.all([tradingApi.searchContracts(symbol, assetClass), getLiveQuoteCapabilities()])
      .then(([{ results }, caps]) => {
        if (cancelled) return
        const hit = results.find((r) => caps.get(r.source) === true && r.contract.aliceId)
        setResolved(hit ? { utaId: hit.source, aliceId: hit.contract.aliceId! } : null)
      })
      .catch(() => { if (!cancelled) setResolved(null) })
    return () => { cancelled = true }
  }, [symbol, assetClass])

  const live = useLiveQuote(resolved?.utaId, resolved ? { aliceId: resolved.aliceId } : undefined)
  return resolved === undefined ? { status: 'connecting', quote: null } : live
}
