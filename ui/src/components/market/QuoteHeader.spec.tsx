// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuoteHeader } from './QuoteHeader'

const mocks = vi.hoisted(() => ({
  quote: vi.fn(),
  useTradeableLiveQuote: vi.fn(),
}))

vi.mock('../../api/market', () => ({
  marketApi: { equity: { quote: mocks.quote } },
}))
vi.mock('../../hooks/useTradeableLiveQuote', () => ({
  useTradeableLiveQuote: mocks.useTradeableLiveQuote,
}))

function vendorQuote(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'yfinance',
    results: [{
      name: 'Apple Inc',
      exchange: 'NMS',
      last_price: 148.2,
      change: -1.8,
      change_percent: -1.2,
      open: 149.5,
      prev_close: 150.0,
      high: 150.1,
      low: 147.9,
      volume: 1_000_000,
      ...overrides,
    }],
  }
}

beforeEach(() => {
  mocks.quote.mockReset()
  mocks.useTradeableLiveQuote.mockReset()
  mocks.useTradeableLiveQuote.mockReturnValue({ status: 'unsupported', quote: null })
})

afterEach(cleanup)

describe('QuoteHeader', () => {
  it('renders the vendor-polled price and provider badge when no live source is available', async () => {
    mocks.quote.mockResolvedValue(vendorQuote())

    render(<QuoteHeader symbol="AAPL" />)

    expect(await screen.findByText('148.20')).toBeTruthy()
    expect(screen.getByText('yfinance')).toBeTruthy()
    expect(screen.queryByText('Live')).toBeNull()
  })

  it('overrides the headline price with the live tick and shows the Live badge, keeping vendor change% untouched', async () => {
    mocks.quote.mockResolvedValue(vendorQuote())
    mocks.useTradeableLiveQuote.mockReturnValue({
      status: 'live',
      quote: { contract: {}, last: '150.75', timestamp: '2026-08-26T00:00:00.000Z' },
    })

    render(<QuoteHeader symbol="AAPL" />)

    await waitFor(() => expect(screen.getByText('150.75')).toBeTruthy())
    expect(screen.getByText('Live')).toBeTruthy()
    // Provider badge is suppressed once live (the headline number no longer
    // comes from that vendor) but change/% still reflects the vendor poll —
    // deliberately not recomputed against the live tick (see file comment).
    expect(screen.queryByText('yfinance')).toBeNull()
    expect(screen.getByText(/-1\.80/)).toBeTruthy()
  })

  it('falls back to the vendor price while still connecting/resolving a live source', async () => {
    mocks.quote.mockResolvedValue(vendorQuote())
    mocks.useTradeableLiveQuote.mockReturnValue({ status: 'connecting', quote: null })

    render(<QuoteHeader symbol="AAPL" />)

    expect(await screen.findByText('148.20')).toBeTruthy()
    expect(screen.queryByText('Live')).toBeNull()
  })

  it('surfaces a vendor quote error', async () => {
    mocks.quote.mockResolvedValue({ provider: 'yfinance', results: [], error: 'symbol not found' })

    render(<QuoteHeader symbol="NOPE" />)

    expect(await screen.findByText('symbol not found')).toBeTruthy()
  })
})
