import { useCallback, useSyncExternalStore } from 'react'
import { getLiveQuoteStore, type ContractRef, type LiveQuoteState } from '../live/live-quotes'

/**
 * Live quote push for one instrument on one UTA account.
 *
 * Returns `status: 'connecting'` until the one-time broker-capability check
 * resolves, `'unsupported'` when that account's broker has no live push
 * (the caller should keep its existing polled quote in that case — this
 * hook never falls back to polling on its own), `'live'` once frames are
 * arriving, or `'error'` if the subscribe attempt itself failed (e.g. "not
 * entitled for real-time quotes").
 *
 * `utaId`/`ref` may be `undefined` while the caller is still resolving
 * which account owns this instrument (e.g. the Market page's contract
 * search hasn't returned yet) — `getLiveQuoteStore` returns a shared no-op
 * store in that case. Deliberately uses `useSyncExternalStore` composed
 * from `LiveStore.subscribe`/`getState` (its plain "non-React" API) rather
 * than `LiveStore.useStore` — `useStore`'s internal refcounting effect has
 * an empty dependency array, so it only bumps the refcount for whichever
 * store was current on FIRST mount; it would silently never subscribe to a
 * newly-resolved store later in this component's lifetime.
 * `useSyncExternalStore` correctly re-subscribes whenever `subscribe`'s
 * identity changes, which happens exactly when `utaId`/`ref` resolve to a
 * different underlying store.
 *
 * `ref` should be referentially stable-ish (same aliceId/symbol) across
 * renders — pass primitives, not a freshly-constructed object each render,
 * since the store is keyed by their string value, not by object identity.
 */
export function useLiveQuote(utaId: string | undefined, ref: ContractRef | undefined): LiveQuoteState {
  const store = getLiveQuoteStore(utaId, ref)
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store])
  const getSnapshot = useCallback(() => store.getState(), [store])
  return useSyncExternalStore(subscribe, getSnapshot)
}
