import { describe, expect, it } from 'vitest'
import type { EquityCurvePoint, OrderHistoryEntry, TradeHistoryEntry } from '../api/types'
import { calculateMaxDrawdown, calculateTradeStats, matchFifoRoundTrips } from './trade-stats'

const contract = { aliceId: 'demo|AAPL', symbol: 'AAPL', secType: 'STK', currency: 'USD' }

function trade(overrides: Partial<TradeHistoryEntry>): TradeHistoryEntry {
  return {
    timestamp: '2026-01-01T00:00:00.000Z', contract, side: 'BUY', quantity: '1',
    price: '100', value: '100', source: 'order', commitHash: 'c1', ...overrides,
  }
}

function order(overrides: Partial<OrderHistoryEntry>): OrderHistoryEntry {
  return {
    timestamp: '2026-01-01T00:00:00.000Z', contract, side: 'BUY', status: 'filled',
    source: 'alice', commitHash: 'c1', message: 'test', ...overrides,
  }
}

describe('matchFifoRoundTrips', () => {
  it('matches chronological FIFO lots and subtracts quantity-weighted fees', () => {
    const rows = matchFifoRoundTrips([
      trade({ timestamp: '2026-01-03T00:00:00Z', orderId: 'sell', side: 'SELL', quantity: '3', price: '130', fee: '3' }),
      trade({ timestamp: '2026-01-01T00:00:00Z', orderId: 'buy-1', quantity: '2', price: '100', fee: '2' }),
      trade({ timestamp: '2026-01-02T00:00:00Z', orderId: 'buy-2', quantity: '2', price: '120', fee: '2' }),
    ])
    expect(rows).toEqual([
      expect.objectContaining({ quantity: '2', grossPnl: '60', fees: '4', netPnl: '56', feeKnown: true }),
      expect.objectContaining({ quantity: '1', grossPnl: '10', fees: '2', netPnl: '8', feeKnown: true }),
    ])
  })

  it('supports FIFO short covering and excludes reconcile rows', () => {
    const rows = matchFifoRoundTrips([
      trade({ side: 'SELL', quantity: '2', price: '120', orderId: 'short' }),
      trade({ timestamp: '2026-01-02T00:00:00Z', side: 'BUY', quantity: '2', price: '100', orderId: 'cover' }),
      trade({ timestamp: '2026-01-03T00:00:00Z', source: 'reconcile', side: 'SELL', quantity: '2', price: '50' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ side: 'SHORT', grossPnl: '40' })
  })
})

describe('calculateMaxDrawdown', () => {
  it('finds the largest chronological peak-to-trough decline with Decimal math', () => {
    const curve: EquityCurvePoint[] = ['100', '120', '90', '110', '80'].map((equity, index) => ({
      timestamp: `2026-01-0${index + 1}T00:00:00Z`, equity, accounts: {},
    }))
    expect(calculateMaxDrawdown(curve)).toEqual({ amount: '40', pct: '33.333333333333333333' })
  })
})

describe('calculateTradeStats', () => {
  it('computes net performance, fee coverage, honest slippage, and market-order gaps', () => {
    const trades = [
      trade({ orderId: 'buy', fee: '1' }),
      trade({ timestamp: '2026-01-02T00:00:00Z', orderId: 'sell', side: 'SELL', price: '110', fee: '1' }),
    ]
    const orders = [
      order({ orderId: 'buy', orderType: 'LMT', limitPrice: '101', avgFillPrice: '100', fee: '1', feeCurrency: 'USD' }),
      order({ orderId: 'sell', side: 'SELL', orderType: 'MKT', avgFillPrice: '110' }),
    ]
    const stats = calculateTradeStats(trades, orders, [])
    expect(stats).toMatchObject({
      closedCount: 1, winningCount: 1, winRate: '100', expectancy: '8', profitFactor: 'Infinity',
      totalFees: '1', feeKnownOrders: 1, feeRelevantOrders: 2, feeCurrency: 'USD',
      slippage: '-1', averageSlippage: '-1', slippageTrackedOrders: 1, slippageUntrackedMarketOrders: 1,
    })
  })

  it('returns explicit empty semantics', () => {
    expect(calculateTradeStats([], [], [])).toMatchObject({
      closedCount: 0, winRate: null, profitFactor: null, expectancy: null,
      maxDrawdown: null, totalFees: '0', feeKnownOrders: 0, feeRelevantOrders: 0,
      slippage: null, slippageTrackedOrders: 0, slippageUntrackedMarketOrders: 0,
    })
  })
})
