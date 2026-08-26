/**
 * Futu wire-shape types — hand-written mirrors of the protobuf messages the
 * read-only FutuBroker consumes, plus the gateway abstraction it talks to.
 *
 * Grounded in the `.proto` files bundled inside the `futu-api` npm package
 * (see `node_modules/futu-api/proto/`): `Trd_Common.proto`,
 * `Qot_Common.proto`, `Qot_GetSecuritySnapshot.proto`, `GetGlobalState.proto`.
 * The SDK ships no TypeScript types, so these interfaces are the typed
 * boundary; protobufjs decodes uint64/int64 fields into Long objects, which
 * is why 64-bit fields are typed as `FutuLongLike` and normalized via
 * `String(...)` at the consumption site.
 */

/** protobufjs decodes (u)int64 as Long; requests accept string/number too. */
export type FutuLongLike = number | string | { toString(): string }

/** Qot_Common.Security — two fields identify one instrument on the wire. */
export interface FutuSecurity {
  market: number
  code: string
}

/** Trd_Common.TrdEnv */
export const FutuTrdEnv = { Simulate: 0, Real: 1 } as const

/** Trd_Common.TrdMarket (subset used by this adapter). */
export const FutuTrdMarket = { HK: 1, US: 2, CN: 3, SG: 6, JP: 15 } as const

/** Qot_Common.QotMarket (subset used by this adapter). */
export const FutuQotMarket = { HK: 1, US: 11, SH: 21, SZ: 22, SG: 31, JP: 41 } as const

/** Trd_Common.TrdSecMarket (subset used by this adapter). */
export const FutuTrdSecMarket = { HK: 1, US: 2, SH: 31, SZ: 32, SG: 41, JP: 51 } as const

/** Trd_Common.PositionSide */
export const FutuPositionSide = { Long: 0, Unknown: -1, Short: 1 } as const

/** Qot_Common.SubType (subset used by this adapter). */
export const FutuSubType = { Basic: 1 } as const

/** Trd_Common.TrdSide — client only ever sends Buy/Sell (see proto comment). */
export const FutuTrdSide = { Unknown: 0, Buy: 1, Sell: 2, SellShort: 3, BuyBack: 4 } as const

/**
 * Trd_Common.OrderType (subset this adapter maps IBKR-style `Order.orderType`
 * onto). TWAP/VWAP/combo/event-contract order types are out of scope — see
 * plans/uta-broker-futu.md Increment 2.
 */
export const FutuOrderType = {
  Unknown: 0, Normal: 1, Market: 2, Stop: 10, StopLimit: 11,
  MarketIfTouched: 12, LimitIfTouched: 13, TrailingStop: 14, TrailingStopLimit: 15,
} as const

/** Trd_Common.OrderStatus. */
export const FutuOrderStatus = {
  Unsubmitted: 0, Unknown: -1, WaitingSubmit: 1, Submitting: 2, SubmitFailed: 3,
  TimeOut: 4, Submitted: 5, FilledPart: 10, FilledAll: 11, CancellingPart: 12,
  CancellingAll: 13, CancelledPart: 14, CancelledAll: 15, Failed: 21, Disabled: 22,
  Deleted: 23, FillCancelled: 24,
} as const

/** Trd_Common.ModifyOrderOp — ModifyOrder also carries cancel (see Cancel=2). */
export const FutuModifyOrderOp = { Unknown: 0, Normal: 1, Cancel: 2, Disable: 3, Enable: 4, Delete: 5 } as const

/** Trd_Common.TimeInForce. */
export const FutuTimeInForce = { Day: 0, GTC: 1, IOC: 2, GTD: 3 } as const

/** Qot_Common.RehabType — 前復權 matches other brokers' adjusted-bar default. */
export const FutuRehabType = { None: 0, Forward: 1, Backward: 2 } as const

/**
 * Qot_Common.KLType (subset mapped from BarInterval — covers all 8 Alice
 * intervals; 3Min/10Min/120Min/180Min/Month/Quarter/Year are unmapped).
 */
export const FutuKLType = {
  Min1: 1, Day: 2, Week: 3, Min5: 6, Min15: 7, Min30: 8, Min60: 9, Min240: 15,
} as const

/** Trd_Common.Currency — enum value to ISO-style code. */
export const FUTU_CURRENCY_CODES: Record<number, string> = {
  1: 'HKD', 2: 'USD', 3: 'CNH', 4: 'JPY', 5: 'SGD', 6: 'AUD', 7: 'CAD', 8: 'MYR', 9: 'NZD',
}

/**
 * Qot_Common.QotMarketState values that mean "continuous trading is
 * happening right now". Auction/pre/post/rest states are treated as closed.
 */
export const FUTU_OPEN_MARKET_STATES: ReadonlySet<number> = new Set([
  3,  // Morning
  5,  // Afternoon
  13, // NightOpen
  15, // FutureDayOpen
  23, // FutureOpen
  25, // FutureBreakOver
  32, // NIGHT (trading)
  35, // TRADE_AT_LAST
  37, // OVERNIGHT (US overnight session)
])

/** Trd_Common.TrdHeader — accID is uint64 on the wire; kept as string here. */
export interface FutuTrdHeader {
  trdEnv: number
  accID: string
  trdMarket: number
}

/** Trd_Common.TrdAcc */
export interface FutuTrdAccLike {
  trdEnv: number
  accID: FutuLongLike
  trdMarketAuthList: number[]
  accType?: number
  simAccType?: number
  accStatus?: number
}

/** Trd_Common.Funds (subset consumed for AccountInfo). */
export interface FutuFundsLike {
  power: number
  totalAssets: number
  cash: number
  marketVal: number
  frozenCash: number
  debtCash: number
  avlWithdrawalCash: number
  currency?: number
  availableFunds?: number
  unrealizedPL?: number
  realizedPL?: number
  initialMargin?: number
  maintenanceMargin?: number
}

/** Trd_Common.Position (subset consumed for Position mapping). */
export interface FutuPositionLike {
  positionID: FutuLongLike
  positionSide: number
  code: string
  name: string
  qty: number
  canSellQty: number
  price: number
  costPrice?: number
  val: number
  plVal: number
  secMarket?: number
  unrealizedPL?: number
  realizedPL?: number
  currency?: number
  trdMarket?: number
  dilutedCostPrice?: number
  averageCostPrice?: number
}

/** Qot_GetSecuritySnapshot SnapshotBasicData (subset consumed for Quote). */
export interface FutuSnapshotBasicLike {
  security: FutuSecurity
  name?: string
  type: number
  isSuspend: boolean
  lotSize: number
  updateTime: string
  highPrice: number
  openPrice: number
  lowPrice: number
  lastClosePrice: number
  curPrice: number
  volume: FutuLongLike
  turnover: number
  updateTimestamp?: number
  askPrice?: number
  bidPrice?: number
}

export interface FutuSnapshotLike {
  basic: FutuSnapshotBasicLike
}

/**
 * Qot_Common.BasicQot (subset consumed from Qot_UpdateBasicQot push).
 * Distinct from FutuSnapshotBasicLike — the "basic quote" message pushed by
 * Qot_Sub's SubType_Basic does NOT carry bid/ask (those live on the order
 * book message behind SubType_OrderBook, out of scope for this increment).
 */
export interface FutuBasicQotLike {
  security: FutuSecurity
  name?: string
  isSuspended: boolean
  updateTime: string
  highPrice: number
  openPrice: number
  lowPrice: number
  curPrice: number
  lastClosePrice: number
  volume: FutuLongLike
  turnover: number
  updateTimestamp?: number
}

/** Qot_Common.SecurityStaticBasic (subset consumed for ContractDetails). */
export interface FutuStaticBasicLike {
  security: FutuSecurity
  id: FutuLongLike
  lotSize: number
  secType: number
  name: string
  listTime: string
  delisting?: boolean
}

export interface FutuStaticInfoLike {
  basic: FutuStaticBasicLike
}

/** GetGlobalState S2C. */
export interface FutuGlobalStateLike {
  marketHK: number
  marketUS: number
  marketSH: number
  marketSZ: number
  marketSG?: number
  marketJP?: number
  qotLogined: boolean
  trdLogined: boolean
  serverVer: number
  time: FutuLongLike
}

/**
 * Trd_Common.Order (subset consumed for GetOrderList / order tracking).
 * Distinct read-side shape from the C2S params below.
 */
export interface FutuOrderLike {
  trdSide: number
  orderType: number
  orderStatus: number
  orderID: FutuLongLike
  orderIDEx: string
  code: string
  name: string
  qty: number
  price?: number
  createTime: string
  updateTime: string
  fillQty?: number
  fillAvgPrice?: number
  lastErrMsg?: string
  secMarket?: number
  currency?: number
  auxPrice?: number
}

/** Trd_Common.OrderFill (subset consumed from Trd_UpdateOrderFill push). */
export interface FutuOrderFillLike {
  trdSide: number
  fillID: FutuLongLike
  fillIDEx?: string
  orderID?: FutuLongLike
  orderIDEx?: string
  code: string
  name?: string
  qty: number
  price: number
  createTime: string
  updateTimestamp?: number
  secMarket?: number
  status?: number
}

/** Trd_Common.OrderFee (subset consumed from Trd_GetOrderFee). */
export interface FutuOrderFeeLike {
  orderIDEx: string
  feeAmount?: number
  feeList?: Array<{ title?: string; value?: number }>
}

/** Trd_PlaceOrder C2S — PacketID is filled in by the SDK, not by callers. */
export interface FutuPlaceOrderParams {
  header: FutuTrdHeader
  trdSide: number
  orderType: number
  code: string
  qty: number
  price?: number
  auxPrice?: number
  timeInForce?: number
}

/** Trd_ModifyOrder C2S (subset: single-order modify/cancel, not forAll). */
export interface FutuModifyOrderParams {
  header: FutuTrdHeader
  orderID: FutuLongLike
  modifyOrderOp: number
  qty?: number
  price?: number
  auxPrice?: number
}

/**
 * Trd_Common.TrdFilterConditions (subset used by Trd_GetHistoryOrderList).
 * beginTime/endTime are REQUIRED by the wire for history pulls, strict
 * `YYYY-MM-DD HH:MM:SS` format per the proto comment. idList filters by
 * orderID primary key.
 */
export interface FutuFilterConditions {
  beginTime: string
  endTime: string
  idList?: FutuLongLike[]
  codeList?: string[]
}

/** Connection-transport event surfaced by FutuGatewayClient (see FutuGateway). */
export interface FutuConnectionEvent {
  state: 'dead' | 'restored'
  error?: string
}

/** Qot_Common.KLine (subset consumed for historical bars). */
export interface FutuKLineLike {
  time: string
  /** True ⇒ placeholder row carrying only time info — no OHLCV. */
  isBlank: boolean
  highPrice?: number
  openPrice?: number
  lowPrice?: number
  closePrice?: number
  volume?: FutuLongLike
  /** Epoch seconds. */
  timestamp?: number
}

/** Qot_RequestHistoryKL C2S (subset — one page per call). */
export interface FutuHistoryKLParams {
  security: FutuSecurity
  rehabType: number
  klType: number
  /** Strict time strings — same YYYY-MM-DD HH:MM:SS convention as Trd filters. */
  beginTime: string
  endTime: string
  maxAckKLNum?: number
  /** Pagination cursor from the previous page's response. */
  nextReqKey?: unknown
}

export interface FutuHistoryKLPage {
  klList: FutuKLineLike[]
  /** Present ⇒ more pages remain; pass back verbatim. */
  nextReqKey?: unknown
}

// ==================== Gateway abstraction ====================

export interface FutuGatewayConfig {
  host: string
  port: number
  ssl: boolean
  wsKey?: string
}

/**
 * The transport surface FutuBroker consumes. The production implementation
 * (`FutuGatewayClient`) wraps `futu-api`'s ftWebsocket; unit tests inject a
 * fake so no FutuOpenD gateway is required.
 */
export interface FutuGateway {
  connect(): Promise<void>
  stop(): void
  getGlobalState(): Promise<FutuGlobalStateLike>
  getAccList(): Promise<FutuTrdAccLike[]>
  getFunds(header: FutuTrdHeader): Promise<FutuFundsLike | null>
  getPositionList(header: FutuTrdHeader): Promise<FutuPositionLike[]>
  getSecuritySnapshot(securities: FutuSecurity[]): Promise<FutuSnapshotLike[]>
  getStaticInfo(securities: FutuSecurity[]): Promise<FutuStaticInfoLike[]>
  /**
   * Subscribe to Qot_UpdateBasicQot push for the given securities (Qot_Sub,
   * SubType_Basic) and register this connection for push (isRegOrUnRegPush).
   * `onUpdate` fires once per pushed batch. Returns an unsubscribe function
   * that reverses both the subscription and the push registration for these
   * securities — it does NOT affect subscriptions for other securities.
   */
  subscribeBasicQuote(
    securities: FutuSecurity[],
    onUpdate: (rows: FutuBasicQotLike[]) => void,
  ): Promise<() => Promise<void>>
  /**
   * Trd_UnlockTrade — unlocks order writes for this FutuOpenD connection
   * (once per OpenD session, not per order). `pwdMD5` is the trade
   * password's MD5 hex digest, never the plaintext password.
   */
  unlockTrade(pwdMD5: string): Promise<void>
  /** Trd_PlaceOrder — returns the broker-assigned order id. */
  placeOrder(params: FutuPlaceOrderParams): Promise<{ orderID: FutuLongLike; orderIDEx?: string }>
  /** Trd_ModifyOrder — also used for cancel via `modifyOrderOp: FutuModifyOrderOp.Cancel`. */
  modifyOrder(params: FutuModifyOrderParams): Promise<{ orderID: FutuLongLike }>
  /** Trd_GetOrderList — today's orders for this trade header. */
  getOrderList(header: FutuTrdHeader): Promise<FutuOrderLike[]>
  /**
   * Trd_GetHistoryOrderList — orders inside `filter`'s (required)
   * beginTime/endTime window, optionally narrowed to specific orderIDs via
   * `filter.idList`. Needed because Trd_GetOrderList only covers TODAY —
   * an overnight GTC order is only findable through this history path.
   */
  getHistoryOrderList(header: FutuTrdHeader, filter: FutuFilterConditions): Promise<FutuOrderLike[]>
  /**
   * Trd_SubAccPush + Trd_UpdateOrder push — register `accID` for order-update
   * push (the accIDList is full-replacement per the proto, but this adapter
   * only ever drives one business account per connection). `onUpdate` fires
   * once per pushed order-state change; `onFill` (optional) once per pushed
   * execution (Trd_UpdateOrderFill — the same SubAccPush registration covers
   * both). The registration is re-established automatically after the SDK's
   * internal transport reconnect.
   */
  subscribeOrderUpdates(
    accID: FutuLongLike,
    onUpdate: (order: FutuOrderLike) => void,
    onFill?: (fill: FutuOrderFillLike) => void,
  ): Promise<void>
  /**
   * Trd_GetOrderFee — real charged fees per SERVER order id (orderIDEx, not
   * the numeric orderID). Only meaningful for orders that have fills.
   */
  getOrderFee(header: FutuTrdHeader, orderIDExList: string[]): Promise<FutuOrderFeeLike[]>
  /**
   * Qot_RequestHistoryKL — ONE page of historical K-lines ("拉取历史K线，
   * 不读本地历史" per the SDK's own cmd table; quota-limited server pull).
   * Callers own the pagination loop via `nextReqKey`.
   */
  requestHistoryKL(params: FutuHistoryKLParams): Promise<FutuHistoryKLPage>
  /**
   * Transport-state notification: `dead` when the underlying WebSocket
   * closes unexpectedly, `restored` after the SDK's built-in auto-reconnect
   * has re-logged-in AND this client has re-established its wire
   * subscriptions (quote + order push). One listener slot; pass null to clear.
   */
  setConnectionListener(listener: ((event: FutuConnectionEvent) => void) | null): void
}


export type FutuGatewayFactory = (config: FutuGatewayConfig) => Promise<FutuGateway> | FutuGateway
