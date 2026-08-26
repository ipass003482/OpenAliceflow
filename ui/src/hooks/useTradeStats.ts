import { useMemo } from 'react'
import type { EquityCurvePoint, OrderHistoryEntry, TradeHistoryEntry } from '../api/types'
import { calculateTradeStats, type TradeStats } from '../lib/trade-stats'

export type TradeStatsState =
  | { status: 'loading'; stats: null }
  | { status: 'ready'; stats: TradeStats }

export function useTradeStats(
  trades: TradeHistoryEntry[] | null,
  orders: OrderHistoryEntry[] | null,
  equityCurve: EquityCurvePoint[],
): TradeStatsState {
  return useMemo(() => {
    if (trades == null || orders == null) return { status: 'loading', stats: null }
    return { status: 'ready', stats: calculateTradeStats(trades, orders, equityCurve) }
  }, [trades, orders, equityCurve])
}
