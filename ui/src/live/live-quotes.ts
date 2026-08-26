/**
 * Live quote push — keyed by (utaId, contract ref).
 *
 * Unlike the single-instance LiveStores elsewhere in `ui/src/live/` (one
 * store per module, e.g. `accountHealthLive`), a live quote needs one
 * connection PER (account, instrument) pair a component actually asks for,
 * not a single global one. `getLiveQuoteStore` lazily creates and caches a
 * `LiveStore` per key on top of `createLiveStore` — its refcounting and
 * visibility-aware reconnect apply unchanged, just narrowed to one key.
 *
 * A subscription first checks `UTASummary.supportsLiveQuote` (a static,
 * per-process broker capability — fetched once and cached, not polled)
 * before ever opening an `EventSource`. Without this preflight, opening the
 * stream against an unsupported/misconfigured account would hit the
 * server's 501 JSON response, which the browser's native EventSource can't
 * distinguish from a transient network failure — it would just retry
 * forever against a route that will never succeed.
 */

import { fetchJson } from '../api/client'
import type { LiveQuoteUpdate, UTASummary } from '../api/types'
import { createLiveStore, type LiveStore } from './createLiveStore'
import { reloadOnHotUpdate } from '../lib/hmr'

reloadOnHotUpdate('live/live-quotes')

export interface ContractRef {
  aliceId?: string
  symbol?: string
}

export type LiveQuoteStatus = 'connecting' | 'live' | 'unsupported' | 'error'

export interface LiveQuoteState {
  status: LiveQuoteStatus
  quote: LiveQuoteUpdate | null
  error?: string
}

const CONNECTING_STATE: LiveQuoteState = { status: 'connecting', quote: null }
const UNSUPPORTED_STATE: LiveQuoteState = { status: 'unsupported', quote: null }

function refKey(ref: ContractRef): string {
  return ref.aliceId ? `aliceId:${ref.aliceId}` : `symbol:${ref.symbol ?? ''}`
}

function refQuery(ref: ContractRef): string {
  const params = new URLSearchParams()
  if (ref.aliceId) params.set('aliceId', ref.aliceId)
  else if (ref.symbol) params.set('symbol', ref.symbol)
  return params.toString()
}

// ==================== Capability cache (static, not polled) ====================
//
// supportsLiveQuote is fixed for the lifetime of the UTA process (it
// reflects which broker class is loaded, not live connection state), so a
// one-time fetch shared across every caller is correct — no periodic
// refresh needed the way accountHealthLive polls actual health.

let capabilityCache: Promise<Map<string, boolean>> | null = null

function loadCapabilities(): Promise<Map<string, boolean>> {
  if (!capabilityCache) {
    capabilityCache = fetchJson<{ utas: UTASummary[] }>('/api/trading/uta')
      .then(({ utas }) => new Map(utas.map((u) => [u.id, u.supportsLiveQuote])))
      .catch(() => new Map<string, boolean>()) // transient failure → treat as "none support it" this session
  }
  return capabilityCache
}

/**
 * Public accessor for the same one-time-fetched capability map, so callers
 * that need to pick WHICH account to subscribe to (e.g. the Market page's
 * "does any UTA matching this vendor symbol support live quotes?" resolver)
 * reuse the identical cached fetch instead of hitting `/api/trading/uta`
 * again themselves.
 */
export function getLiveQuoteCapabilities(): Promise<Map<string, boolean>> {
  return loadCapabilities()
}

/** Test-only: force the next `supportsLiveQuote` check to refetch. */
export function resetLiveQuoteCapabilityCache(): void {
  capabilityCache = null
}

// ==================== Keyed store ====================

const stores = new Map<string, LiveStore<LiveQuoteState>>()

/** Shared no-op store for "nothing to subscribe to yet" (no utaId/ref
 *  resolved). Never opens a connection — exists so `useLiveQuote` can call
 *  `.useStore()` unconditionally every render (Rules of Hooks) instead of
 *  branching around a possibly-absent store. */
const noopStore = createLiveStore<LiveQuoteState>({
  name: 'live-quote:noop',
  initialState: UNSUPPORTED_STATE,
  subscribe: () => () => {},
})

/**
 * Get (or lazily create) the shared LiveStore for one (utaId, ref) pair.
 * Every component watching the same instrument shares one EventSource —
 * `createLiveStore`'s refcounting closes it once the last watcher unmounts.
 * Returns the shared no-op store when `utaId`/`ref` don't resolve to
 * anything subscribable yet.
 *
 * Store entries are cached for the session once created (not evicted at
 * refcount zero) — the state object is a few small fields, and the number
 * of distinct instruments a user views in one session is naturally low, so
 * this is a deliberate, accepted tradeoff rather than building eviction
 * machinery for a hypothetical unbounded-growth case.
 */
export function getLiveQuoteStore(utaId: string | undefined, ref: ContractRef | undefined): LiveStore<LiveQuoteState> {
  if (!utaId || !(ref?.aliceId || ref?.symbol)) return noopStore
  const key = `${utaId}|${refKey(ref)}`
  const existing = stores.get(key)
  if (existing) return existing

  const store = createLiveStore<LiveQuoteState>({
    name: `live-quote:${key}`,
    initialState: CONNECTING_STATE,
    subscribe: ({ apply }) => {
      let es: EventSource | null = null
      let disposed = false

      loadCapabilities().then((caps) => {
        if (disposed) return
        if (!caps.get(utaId)) {
          apply(UNSUPPORTED_STATE)
          return
        }
        es = new EventSource(`/api/trading/uta/${utaId}/quote-stream?${refQuery(ref)}`)
        es.addEventListener('quote', (event) => {
          try {
            const quote = JSON.parse((event as MessageEvent).data) as LiveQuoteUpdate
            apply({ status: 'live', quote })
          } catch { /* ignore a malformed frame — keep the last good quote */ }
        })
        es.addEventListener('error', (event) => {
          // Named "error" SSE event — the server's subscribeQuote() call
          // itself failed (e.g. broker not entitled). Distinct from the
          // EventSource transport-level onerror below.
          try {
            const body = JSON.parse((event as MessageEvent).data) as { error?: string }
            apply({ status: 'error', quote: null, error: body.error })
          } catch {
            apply({ status: 'error', quote: null })
          }
        })
        es.onerror = () => {
          // Transport-level failure. The browser's EventSource retries
          // automatically; reflect "not currently live" without tearing
          // down — a reconnect may still succeed.
          apply((prev) => (prev.status === 'live' ? { status: 'error', quote: prev.quote } : prev))
        }
      })

      return () => {
        disposed = true
        es?.close()
      }
    },
    // Quotes can legitimately go quiet for seconds during illiquid periods —
    // much longer than accountHealthLive's 15s window. 90s avoids
    // reconnect-thrashing a healthy-but-quiet subscription.
    staleAfterMs: 90_000,
  })
  stores.set(key, store)
  return store
}

/** Test-only: drop every cached per-key store so a fresh test doesn't
 *  observe a previous test's leftover state for the same (utaId, ref) key. */
export function resetLiveQuoteStores(): void {
  stores.clear()
}
