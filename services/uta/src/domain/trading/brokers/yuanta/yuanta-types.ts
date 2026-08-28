export interface YuantaBridgeConfig {
  account: string
  password: string
  environment: 'uat'
  runtimeDir?: string
  bridgePath?: string
}

export interface YuantaRpcResponse<T = unknown> {
  id: string
  ok: boolean
  result?: T
  error?: { code?: string; message: string }
}

export interface YuantaPositionRow {
  stockCode?: string
  stockName?: string
  quantity?: string | number
  balanceQty?: string | number
  costPrice?: string | number
  marketPrice?: string | number
  marketValue?: string | number
  unrealizedProfitLoss?: string | number
  realizedProfitLoss?: string | number
  marketType?: string | number
}

export interface YuantaOrderRow {
  orderNo?: string
  stockCode?: string
  buySell?: string
  orderQty?: string | number
  dealQty?: string | number
  price?: string | number
  dealPrice?: string | number
  priceFlag?: string
  orderStatus?: string
  tradeKind?: string
  apCode?: string | number
  timeInForce?: string
}
