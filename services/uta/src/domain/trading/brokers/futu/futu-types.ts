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
}

export type FutuGatewayFactory = (config: FutuGatewayConfig) => Promise<FutuGateway> | FutuGateway
