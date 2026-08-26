/// <reference path="./futu-api.d.ts" />
/**
 * FutuGatewayClient — production FutuGateway implementation over the
 * `futu-api` SDK's ftWebsocket transport.
 *
 * ftWebsocket opens a WebSocket to a locally running FutuOpenD gateway
 * (InitWebSocket handshake with an optional MD5-hashed key), then exchanges
 * protobuf-encoded Request/Response pairs per command. `_sendCmd` already
 * rejects any response whose `retType !== 0`, so success paths here only
 * narrow the decoded `s2c` payload to the typed shapes in `futu-types.ts`.
 *
 * NOT verified against a live FutuOpenD gateway — no gateway or Futu account
 * is available in this development environment. The shapes follow the
 * bundled `.proto` files and `main.js` source; treat runtime behavior as
 * unverified until a real gateway acceptance run happens (see
 * plans/uta-broker-futu.md).
 */

import ftWebsocket, { ftCmdID } from 'futu-api'
import {
  type FutuGateway,
  type FutuGatewayConfig,
  type FutuGlobalStateLike,
  type FutuTrdAccLike,
  type FutuTrdHeader,
  type FutuFundsLike,
  type FutuPositionLike,
  type FutuSecurity,
  type FutuSnapshotLike,
  type FutuStaticInfoLike,
  type FutuBasicQotLike,
  type FutuOrderLike,
  type FutuPlaceOrderParams,
  type FutuModifyOrderParams,
  type FutuFilterConditions,
  type FutuConnectionEvent,
  type FutuHistoryKLParams,
  type FutuHistoryKLPage,
  type FutuKLineLike,
  type FutuOrderFillLike,
  type FutuOrderFeeLike,
  type FutuLongLike,
  FutuSubType,
} from './futu-types.js'

const CONNECT_TIMEOUT_MS = 20_000

/** `${market}.${code}` — a stable dedupe/lookup key for a wire Security. */
function securityKey(s: FutuSecurity): string {
  return `${s.market}.${s.code}`
}

/** Reverse of securityKey — the market prefix never contains a dot. */
function keyToWireSecurity(key: string): FutuSecurity {
  const dot = key.indexOf('.')
  return { market: Number(key.slice(0, dot)), code: key.slice(dot + 1) }
}

interface QuoteSubscription {
  securities: Set<string>
  onUpdate: (rows: FutuBasicQotLike[]) => void
}

export class FutuGatewayClient implements FutuGateway {
  private readonly cfg: FutuGatewayConfig
  private ws: ftWebsocket | null = null
  private nextSubscriptionId = 1
  private readonly quoteSubscriptions = new Map<number, QuoteSubscription>()
  private connectionListener: ((event: FutuConnectionEvent) => void) | null = null
  private orderPush: {
    accID: FutuLongLike
    onUpdate: (order: FutuOrderLike) => void
    onFill?: (fill: FutuOrderFillLike) => void
  } | null = null
  /** True during a deliberate stop() — suppresses dead-connection events. */
  private stopping = false
  /** Set once the FIRST login handshake settles; later onlogin(true) calls
   *  come from the SDK base's built-in auto-reconnect (base.js re-runs
   *  initWebSocket after a non-deliberate socket close). */
  private loggedInOnce = false

  constructor(cfg: FutuGatewayConfig) {
    this.cfg = cfg
  }

  async connect(): Promise<void> {
    const ws = new ftWebsocket()
    this.ws = ws
    this.stopping = false
    this.loggedInOnce = false
    ws.onPush = (cmd, response) => this.handlePush(cmd, response)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`FutuOpenD connect timed out after ${CONNECT_TIMEOUT_MS}ms (${this.cfg.host}:${this.cfg.port})`))
      }, CONNECT_TIMEOUT_MS)
      ws.onlogin = (ret, msg) => {
        if (!this.loggedInOnce) {
          this.loggedInOnce = true
          clearTimeout(timer)
          if (ret) resolve()
          else reject(new Error(`FutuOpenD login failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`))
          return
        }
        // A later successful login means the SDK auto-reconnected after a
        // dropped socket. Wire-level subscriptions died with the old socket,
        // so rebuild them before telling the owner the transport is back.
        if (ret && !this.stopping) void this.restoreAfterReconnect()
      }
      ws.start(this.cfg.host, this.cfg.port, this.cfg.ssl, this.cfg.wsKey ?? null)
    })
    this.attachTransportHooks(ws)
  }

  stop(): void {
    this.stopping = true
    this.ws?.stop()
    this.ws = null
    this.quoteSubscriptions.clear()
    this.orderPush = null
  }

  setConnectionListener(listener: ((event: FutuConnectionEvent) => void) | null): void {
    this.connectionListener = listener
  }

  /**
   * The wrapper ftWebsocket does not forward the base transport's
   * onclose/onerror user hooks, so connection-loss detection attaches to the
   * base directly (`ws.websock`). The hook survives the base's internal
   * reconnect cycles — initWebSocket re-runs but the base instance persists.
   */
  private attachTransportHooks(ws: ftWebsocket): void {
    const base = ws.websock
    if (!base) return
    base.onclose = () => {
      if (this.stopping) return
      this.connectionListener?.({ state: 'dead', error: 'FutuOpenD WebSocket closed unexpectedly (SDK auto-reconnect is running)' })
    }
  }

  /** Re-establish every wire subscription on the freshly reconnected socket. */
  private async restoreAfterReconnect(): Promise<void> {
    const ws = this.ws
    if (!ws) return
    try {
      const wanted = new Map<string, FutuSecurity>()
      for (const sub of this.quoteSubscriptions.values()) {
        for (const key of sub.securities) {
          if (!wanted.has(key)) wanted.set(key, keyToWireSecurity(key))
        }
      }
      if (wanted.size > 0) {
        await ws.Sub({
          c2s: {
            securityList: [...wanted.values()],
            subTypeList: [FutuSubType.Basic],
            isSubOrUnSub: true,
            isRegOrUnRegPush: true,
          },
        })
      }
      if (this.orderPush) {
        await ws.SubAccPush({ c2s: { accIDList: [this.orderPush.accID] } })
      }
      this.connectionListener?.({ state: 'restored' })
    } catch (err) {
      // The socket may have dropped again mid-restore. Report dead so the
      // owning account's recovery loop rebuilds the whole broker.
      this.connectionListener?.({
        state: 'dead',
        error: `Re-subscribe after FutuOpenD reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  async getGlobalState(): Promise<FutuGlobalStateLike> {
    const resp = await this.require().GetGlobalState({ c2s: { userID: 0 } })
    return this.s2c<FutuGlobalStateLike>(resp, 'GetGlobalState')
  }

  async getAccList(): Promise<FutuTrdAccLike[]> {
    const resp = await this.require().GetAccList({ c2s: { userID: 0 } })
    return this.s2c<{ accList?: FutuTrdAccLike[] }>(resp, 'GetAccList').accList ?? []
  }

  async getFunds(header: FutuTrdHeader): Promise<FutuFundsLike | null> {
    const resp = await this.require().GetFunds({ c2s: { header } })
    return this.s2c<{ funds?: FutuFundsLike }>(resp, 'GetFunds').funds ?? null
  }

  async getPositionList(header: FutuTrdHeader): Promise<FutuPositionLike[]> {
    const resp = await this.require().GetPositionList({ c2s: { header } })
    return this.s2c<{ positionList?: FutuPositionLike[] }>(resp, 'GetPositionList').positionList ?? []
  }

  async getSecuritySnapshot(securities: FutuSecurity[]): Promise<FutuSnapshotLike[]> {
    const resp = await this.require().GetSecuritySnapshot({ c2s: { securityList: securities } })
    return this.s2c<{ snapshotList?: FutuSnapshotLike[] }>(resp, 'GetSecuritySnapshot').snapshotList ?? []
  }

  async getStaticInfo(securities: FutuSecurity[]): Promise<FutuStaticInfoLike[]> {
    const resp = await this.require().GetStaticInfo({ c2s: { securityList: securities } })
    return this.s2c<{ staticInfoList?: FutuStaticInfoLike[] }>(resp, 'GetStaticInfo').staticInfoList ?? []
  }

  // ---- Trading writes ----

  /** Trd_UnlockTrade — "解锁，针对OpenD解锁一次即可" per the SDK's own doc comment. */
  async unlockTrade(pwdMD5: string): Promise<void> {
    await this.require().UnlockTrade({ c2s: { unlock: true, pwdMD5 } })
  }

  /** Trd_PlaceOrder. PacketID is filled in by the SDK ("PacketID不需填写，发送时接口会填"). */
  async placeOrder(params: FutuPlaceOrderParams): Promise<{ orderID: FutuLongLike; orderIDEx?: string }> {
    const resp = await this.require().PlaceOrder({
      c2s: {
        header: params.header,
        trdSide: params.trdSide,
        orderType: params.orderType,
        code: params.code,
        qty: params.qty,
        price: params.price,
        auxPrice: params.auxPrice,
        timeInForce: params.timeInForce,
      },
    })
    return this.s2c<{ orderID: FutuLongLike; orderIDEx?: string }>(resp, 'PlaceOrder')
  }

  /** Trd_ModifyOrder — same call handles price/qty changes AND cancel (modifyOrderOp). */
  async modifyOrder(params: FutuModifyOrderParams): Promise<{ orderID: FutuLongLike }> {
    const resp = await this.require().ModifyOrder({
      c2s: {
        header: params.header,
        orderID: params.orderID,
        modifyOrderOp: params.modifyOrderOp,
        qty: params.qty,
        price: params.price,
        auxPrice: params.auxPrice,
      },
    })
    return this.s2c<{ orderID: FutuLongLike }>(resp, 'ModifyOrder')
  }

  /** Trd_GetOrderList — today's orders for this trade header. */
  async getOrderList(header: FutuTrdHeader): Promise<FutuOrderLike[]> {
    const resp = await this.require().GetOrderList({ c2s: { header } })
    return this.s2c<{ orderList?: FutuOrderLike[] }>(resp, 'GetOrderList').orderList ?? []
  }

  /** Trd_GetHistoryOrderList — orders inside the filter's required time window. */
  async getHistoryOrderList(header: FutuTrdHeader, filter: FutuFilterConditions): Promise<FutuOrderLike[]> {
    const resp = await this.require().GetHistoryOrderList({
      c2s: {
        header,
        filterConditions: {
          beginTime: filter.beginTime,
          endTime: filter.endTime,
          ...(filter.idList ? { idList: filter.idList } : {}),
          ...(filter.codeList ? { codeList: filter.codeList } : {}),
        },
      },
    })
    return this.s2c<{ orderList?: FutuOrderLike[] }>(resp, 'GetHistoryOrderList').orderList ?? []
  }

  /**
   * Trd_SubAccPush registers this connection for Trd_UpdateOrder pushes.
   * accIDList is full-replacement on the wire (per the proto comment), but
   * this adapter only ever drives one business account per connection, so a
   * single registration slot suffices. Re-registered automatically by
   * restoreAfterReconnect after the SDK's internal transport reconnect.
   */
  async subscribeOrderUpdates(
    accID: FutuLongLike,
    onUpdate: (order: FutuOrderLike) => void,
    onFill?: (fill: FutuOrderFillLike) => void,
  ): Promise<void> {
    const ws = this.require()
    this.orderPush = { accID, onUpdate, ...(onFill ? { onFill } : {}) }
    try {
      await ws.SubAccPush({ c2s: { accIDList: [accID] } })
    } catch (err) {
      this.orderPush = null
      throw err
    }
  }

  /** Trd_GetOrderFee — real charged fees, keyed by server order id (orderIDEx). */
  async getOrderFee(header: FutuTrdHeader, orderIDExList: string[]): Promise<FutuOrderFeeLike[]> {
    if (orderIDExList.length === 0) return []
    // Wire field is `orderIdExList` (lowercase d) per Trd_GetOrderFee.proto.
    const resp = await this.require().GetOrderFee({ c2s: { header, orderIdExList: orderIDExList } })
    return this.s2c<{ orderFeeList?: FutuOrderFeeLike[] }>(resp, 'GetOrderFee').orderFeeList ?? []
  }

  /** Qot_RequestHistoryKL — one page; pagination cursor passed back verbatim. */
  async requestHistoryKL(params: FutuHistoryKLParams): Promise<FutuHistoryKLPage> {
    const resp = await this.require().RequestHistoryKL({
      c2s: {
        rehabType: params.rehabType,
        klType: params.klType,
        security: params.security,
        beginTime: params.beginTime,
        endTime: params.endTime,
        ...(params.maxAckKLNum !== undefined ? { maxAckKLNum: params.maxAckKLNum } : {}),
        ...(params.nextReqKey !== undefined ? { nextReqKey: params.nextReqKey } : {}),
      },
    })
    const s2c = this.s2c<{ klList?: FutuKLineLike[]; nextReqKey?: unknown }>(resp, 'RequestHistoryKL')
    return {
      klList: s2c.klList ?? [],
      ...(s2c.nextReqKey !== undefined && s2c.nextReqKey !== null ? { nextReqKey: s2c.nextReqKey } : {}),
    }
  }

  /**
   * Subscribe to Qot_UpdateBasicQot push (Qot_Sub, SubType_Basic). Multiple
   * concurrent subscriptions share the single underlying `ftWebsocket`
   * connection and `onPush` callback slot — `handlePush` fans pushed rows out
   * to every subscription whose security set matches. Unsubscribe reference-
   * counts across subscriptions: a security is only un-subscribed on the wire
   * once no remaining subscription still wants it, so overlapping callers
   * (e.g. two Market-page widgets watching the same symbol) never steal each
   * other's push feed.
   */
  async subscribeBasicQuote(
    securities: FutuSecurity[],
    onUpdate: (rows: FutuBasicQotLike[]) => void,
  ): Promise<() => Promise<void>> {
    const ws = this.require()
    await ws.Sub({
      c2s: {
        securityList: securities,
        subTypeList: [FutuSubType.Basic],
        isSubOrUnSub: true,
        isRegOrUnRegPush: true,
      },
    })
    const id = this.nextSubscriptionId++
    this.quoteSubscriptions.set(id, { securities: new Set(securities.map(securityKey)), onUpdate })

    return async () => {
      this.quoteSubscriptions.delete(id)
      const wanted = new Set<string>()
      for (const sub of this.quoteSubscriptions.values()) {
        for (const key of sub.securities) wanted.add(key)
      }
      const toUnsub = securities.filter((s) => !wanted.has(securityKey(s)))
      if (toUnsub.length === 0) return
      try {
        await ws.Sub({
          c2s: {
            securityList: toUnsub,
            subTypeList: [FutuSubType.Basic],
            isSubOrUnSub: false,
            isRegOrUnRegPush: false,
          },
        })
      } catch (err) {
        // Best-effort: the connection may already be closing (stop()).
        // Losing an explicit unsubscribe ack is not actionable by the caller.
        console.warn('FutuGatewayClient: unsubscribe failed (ignored):', err instanceof Error ? err.message : err)
      }
    }
  }

  private handlePush(cmd: number, response: unknown): void {
    if (cmd === ftCmdID['TrdUpdateOrder']?.cmd) {
      const order = (response as { s2c?: { order?: FutuOrderLike } } | undefined)?.s2c?.order
      if (order) this.orderPush?.onUpdate(order)
      return
    }
    if (cmd === ftCmdID['TrdUpdateOrderFill']?.cmd) {
      const fill = (response as { s2c?: { orderFill?: FutuOrderFillLike } } | undefined)?.s2c?.orderFill
      if (fill) this.orderPush?.onFill?.(fill)
      return
    }
    if (cmd !== ftCmdID['QotUpdateBasicQot']?.cmd) return
    const rows = (response as { s2c?: { basicQotList?: FutuBasicQotLike[] } } | undefined)?.s2c?.basicQotList
    if (!rows || rows.length === 0) return
    for (const sub of this.quoteSubscriptions.values()) {
      const matched = rows.filter((r) => sub.securities.has(securityKey(r.security)))
      if (matched.length > 0) sub.onUpdate(matched)
    }
  }

  private require(): ftWebsocket {
    if (!this.ws) throw new Error('FutuGatewayClient is not connected — call connect() first')
    return this.ws
  }

  private s2c<T>(resp: { s2c?: unknown }, what: string): T {
    if (!resp.s2c) throw new Error(`FutuOpenD ${what} response is missing its s2c payload`)
    return resp.s2c as T
  }
}
