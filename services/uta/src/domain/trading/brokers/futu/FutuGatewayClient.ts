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
  FutuSubType,
} from './futu-types.js'

const CONNECT_TIMEOUT_MS = 20_000

/** `${market}.${code}` — a stable dedupe/lookup key for a wire Security. */
function securityKey(s: FutuSecurity): string {
  return `${s.market}.${s.code}`
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

  constructor(cfg: FutuGatewayConfig) {
    this.cfg = cfg
  }

  async connect(): Promise<void> {
    const ws = new ftWebsocket()
    this.ws = ws
    ws.onPush = (cmd, response) => this.handlePush(cmd, response)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`FutuOpenD connect timed out after ${CONNECT_TIMEOUT_MS}ms (${this.cfg.host}:${this.cfg.port})`))
      }, CONNECT_TIMEOUT_MS)
      ws.onlogin = (ret, msg) => {
        clearTimeout(timer)
        if (ret) resolve()
        else reject(new Error(`FutuOpenD login failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`))
      }
      ws.start(this.cfg.host, this.cfg.port, this.cfg.ssl, this.cfg.wsKey ?? null)
    })
  }

  stop(): void {
    this.ws?.stop()
    this.ws = null
    this.quoteSubscriptions.clear()
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
    if (cmd !== ftCmdID['QotUpdateBasicQot'].cmd) return
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
