// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTradeableLiveQuote } from './useTradeableLiveQuote'

const mocks = vi.hoisted(() => ({
  searchContracts: vi.fn(),
  getLiveQuoteCapabilities: vi.fn(),
  useLiveQuote: vi.fn(),
}))

vi.mock('../api/trading', () => ({
  tradingApi: { searchContracts: mocks.searchContracts },
}))
vi.mock('../live/live-quotes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../live/live-quotes')>()),
  getLiveQuoteCapabilities: mocks.getLiveQuoteCapabilities,
}))
vi.mock('./useLiveQuote', () => ({
  useLiveQuote: mocks.useLiveQuote,
}))

function hit(source: string, aliceId: string) {
  return { source, contract: { aliceId }, derivativeSecTypes: [] }
}

beforeEach(() => {
  mocks.searchContracts.mockReset()
  mocks.getLiveQuoteCapabilities.mockReset()
  mocks.useLiveQuote.mockReset()
  mocks.useLiveQuote.mockReturnValue({ status: 'unsupported', quote: null })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useTradeableLiveQuote', () => {
  it('reports connecting while the search + capability lookup are in flight', () => {
    mocks.searchContracts.mockReturnValue(new Promise(() => {})) // never resolves
    mocks.getLiveQuoteCapabilities.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useTradeableLiveQuote('AAPL', 'equity'))
    expect(result.current.status).toBe('connecting')
  })

  it('picks the first hit whose account supports live quotes and subscribes via useLiveQuote', async () => {
    mocks.searchContracts.mockResolvedValue({
      count: 2,
      results: [hit('alpaca-paper', 'alpaca-paper|AAPL'), hit('futu-sim', 'futu-sim|US.AAPL')],
    })
    mocks.getLiveQuoteCapabilities.mockResolvedValue(new Map([['alpaca-paper', false], ['futu-sim', true]]))
    mocks.useLiveQuote.mockReturnValue({ status: 'live', quote: { contract: {}, last: '150.5', timestamp: '2026-08-26T00:00:00.000Z' } })

    const { result } = renderHook(() => useTradeableLiveQuote('AAPL', 'equity'))

    await waitFor(() => expect(mocks.useLiveQuote).toHaveBeenCalledWith('futu-sim', { aliceId: 'futu-sim|US.AAPL' }))
    expect(result.current.status).toBe('live')
  })

  it('resolves to unsupported (no subscribe attempt) when no hit has a live-quote-capable account', async () => {
    mocks.searchContracts.mockResolvedValue({ count: 1, results: [hit('alpaca-paper', 'alpaca-paper|AAPL')] })
    mocks.getLiveQuoteCapabilities.mockResolvedValue(new Map([['alpaca-paper', false]]))

    renderHook(() => useTradeableLiveQuote('AAPL', 'equity'))

    await waitFor(() => expect(mocks.useLiveQuote).toHaveBeenCalledWith(undefined, undefined))
  })

  it('resolves to unsupported when the search itself fails', async () => {
    mocks.searchContracts.mockRejectedValue(new Error('network down'))
    mocks.getLiveQuoteCapabilities.mockResolvedValue(new Map())

    renderHook(() => useTradeableLiveQuote('AAPL', 'equity'))

    await waitFor(() => expect(mocks.useLiveQuote).toHaveBeenCalledWith(undefined, undefined))
  })
})
