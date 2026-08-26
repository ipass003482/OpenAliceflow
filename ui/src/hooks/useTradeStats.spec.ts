// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { OrderHistoryEntry, TradeHistoryEntry } from '../api/types'
import { useTradeStats } from './useTradeStats'

const contract = { aliceId: 'demo|AAPL', symbol: 'AAPL', currency: 'USD' }
const buy: TradeHistoryEntry = {
  timestamp: '2026-01-01T00:00:00Z', orderId: 'b', contract, side: 'BUY', quantity: '1',
  price: '100', value: '100', source: 'order', commitHash: 'c1',
}
const sell: TradeHistoryEntry = {
  ...buy, timestamp: '2026-01-02T00:00:00Z', orderId: 's', side: 'SELL', price: '110', value: '110', commitHash: 'c2',
}
const orders: OrderHistoryEntry[] = [
  { timestamp: buy.timestamp, orderId: 'b', contract, side: 'BUY', status: 'filled', source: 'alice', commitHash: 'c1', message: 'buy' },
  { timestamp: sell.timestamp, orderId: 's', contract, side: 'SELL', status: 'filled', source: 'alice', commitHash: 'c2', message: 'sell' },
]

describe('useTradeStats', () => {
  it('stays loading until both histories are available', () => {
    const { result } = renderHook(() => useTradeStats(null, orders, []))
    expect(result.current).toEqual({ status: 'loading', stats: null })
  })

  it('selects the supplied rows and exposes empty and closed-round-trip states', () => {
    const empty = renderHook(() => useTradeStats([], [], []))
    expect(empty.result.current.stats?.closedCount).toBe(0)

    const ready = renderHook(() => useTradeStats([buy, sell], orders, []))
    expect(ready.result.current).toMatchObject({ status: 'ready', stats: { closedCount: 1, expectancy: '10' } })
  })
})
