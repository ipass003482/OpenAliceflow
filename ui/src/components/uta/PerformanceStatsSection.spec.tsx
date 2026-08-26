// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PerformanceStatsSection } from './PerformanceStatsSection'
import type { TradeStats } from '../../lib/trade-stats'

const stats: TradeStats = {
  closedRoundTrips: [], closedCount: 2, winningCount: 1, winRate: '50', profitFactor: '2.5', expectancy: '12.5',
  maxDrawdown: '100', maxDrawdownPct: '5', totalFees: '3.25', feeCurrency: 'USD', feeKnownOrders: 2,
  feeRelevantOrders: 4, slippage: '0.25', averageSlippage: '0.125', slippageCurrency: 'USD',
  slippageTrackedOrders: 2, slippageUntrackedMarketOrders: 1,
}

afterEach(cleanup)

describe('PerformanceStatsSection', () => {
  it('renders tiles, fee honesty marker, and market-order tracking gap', () => {
    render(<PerformanceStatsSection state={{ status: 'ready', stats }} currency="USD" />)
    expect(screen.getByText('50%')).toBeTruthy()
    expect(screen.getByText('fees known for 2 of 4 orders')).toBeTruthy()
    expect(screen.getByText('2 limit tracked · 1 market untracked')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('未將缺失值假設為 0')
  })

  it('has an honest empty state and an accessible disclosure control', () => {
    render(<PerformanceStatsSection state={{ status: 'ready', stats: { ...stats, closedCount: 0 } }} currency="USD" />)
    expect(screen.getByText('尚無已平倉交易')).toBeTruthy()
    const toggle = screen.getByRole('button', { name: '收合' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('尚無已平倉交易')).toBeNull()
  })
})
