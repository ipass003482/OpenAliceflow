// @vitest-environment jsdom

import { renderHook, waitFor, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLiveQuote } from './useLiveQuote'
import { resetLiveQuoteCapabilityCache, resetLiveQuoteStores } from '../live/live-quotes'

// ==================== fetchJson mock (capability preflight) ====================

vi.mock('../api/client', () => ({
  fetchJson: vi.fn(),
}))
import { fetchJson } from '../api/client'

// ==================== EventSource fake ====================
//
// jsdom has no native EventSource. Mirrors the real API surface
// live-quotes.ts actually drives: addEventListener('quote'|'error', ...),
// onerror, close(). Tracks constructed instances so tests can assert
// de-duplication (two watchers of the same key share one connection).

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  private readonly listeners: Record<string, Array<(e: MessageEvent) => void>> = {}
  onerror: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    (this.listeners[type] ??= []).push(cb)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) } as MessageEvent)
  }

  triggerTransportError(): void {
    this.onerror?.()
  }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  resetLiveQuoteCapabilityCache()
  resetLiveQuoteStores()
  vi.mocked(fetchJson).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockCapabilities(utas: Array<{ id: string; supportsLiveQuote: boolean }>) {
  vi.mocked(fetchJson).mockResolvedValue({ utas })
}

describe('useLiveQuote', () => {
  it('reports unsupported without opening an EventSource when the account has no live-quote support', async () => {
    mockCapabilities([{ id: 'futu-sim', supportsLiveQuote: false }])
    const { result } = renderHook(() => useLiveQuote('futu-sim', { aliceId: 'futu-sim|HK.00700' }))

    expect(result.current.status).toBe('connecting')
    await waitFor(() => expect(result.current.status).toBe('unsupported'))
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('opens an EventSource and transitions to live on the first pushed quote frame', async () => {
    mockCapabilities([{ id: 'futu-sim', supportsLiveQuote: true }])
    const { result } = renderHook(() => useLiveQuote('futu-sim', { aliceId: 'futu-sim|HK.00700' }))

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const es = FakeEventSource.instances[0]
    expect(es.url).toBe('/api/trading/uta/futu-sim/quote-stream?aliceId=futu-sim%7CHK.00700')

    act(() => {
      es.emit('quote', { contract: { aliceId: 'futu-sim|HK.00700' }, last: '620.5', timestamp: '2026-08-26T00:00:00.000Z' })
    })

    await waitFor(() => expect(result.current.status).toBe('live'))
    expect(result.current.quote?.last).toBe('620.5')
  })

  it('shares one EventSource across two hook instances watching the same (utaId, aliceId)', async () => {
    mockCapabilities([{ id: 'futu-sim', supportsLiveQuote: true }])
    const a = renderHook(() => useLiveQuote('futu-sim', { aliceId: 'futu-sim|HK.00700' }))
    const b = renderHook(() => useLiveQuote('futu-sim', { aliceId: 'futu-sim|HK.00700' }))

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    act(() => {
      FakeEventSource.instances[0].emit('quote', { contract: {}, last: '1', timestamp: '2026-08-26T00:00:00.000Z' })
    })

    await waitFor(() => expect(a.result.current.status).toBe('live'))
    expect(b.result.current.status).toBe('live')
  })

  it('closes the EventSource only once every watcher of that key has unmounted', async () => {
    mockCapabilities([{ id: 'futu-sim', supportsLiveQuote: true }])
    const a = renderHook(() => useLiveQuote('futu-sim', { aliceId: 'futu-sim|HK.00700' }))
    const b = renderHook(() => useLiveQuote('futu-sim', { aliceId: 'futu-sim|HK.00700' }))
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const es = FakeEventSource.instances[0]

    a.unmount()
    expect(es.closed).toBe(false) // b is still watching

    b.unmount()
    expect(es.closed).toBe(true)
  })

  it('surfaces a named "error" SSE frame (subscribe itself failed) without fabricating a quote', async () => {
    mockCapabilities([{ id: 'futu-sim', supportsLiveQuote: true }])
    const { result } = renderHook(() => useLiveQuote('futu-sim', { aliceId: 'futu-sim|HK.00700' }))
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    act(() => {
      FakeEventSource.instances[0].emit('error', { error: 'not entitled for real-time quotes' })
    })

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.quote).toBeNull()
    expect(result.current.error).toMatch(/not entitled/)
  })

  it('demotes to error on a transport failure but keeps the last-known quote', async () => {
    mockCapabilities([{ id: 'futu-sim', supportsLiveQuote: true }])
    const { result } = renderHook(() => useLiveQuote('futu-sim', { aliceId: 'futu-sim|HK.00700' }))
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const es = FakeEventSource.instances[0]

    act(() => { es.emit('quote', { contract: {}, last: '620.5', timestamp: '2026-08-26T00:00:00.000Z' }) })
    await waitFor(() => expect(result.current.status).toBe('live'))

    act(() => { es.triggerTransportError() })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.quote?.last).toBe('620.5')
  })

  it('returns unsupported without any subscription attempt when utaId/ref are not resolved yet', () => {
    const { result } = renderHook(() => useLiveQuote(undefined, undefined))
    expect(result.current.status).toBe('unsupported')
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(fetchJson).not.toHaveBeenCalled()
  })
})
