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

import ftWebsocket from 'futu-api'
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
} from './futu-types.js'

const CONNECT_TIMEOUT_MS = 20_000

export class FutuGatewayClient implements FutuGateway {
  private readonly cfg: FutuGatewayConfig
  private ws: ftWebsocket | null = null

  constructor(cfg: FutuGatewayConfig) {
    this.cfg = cfg
  }

  async connect(): Promise<void> {
    const ws = new ftWebsocket()
    this.ws = ws
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

  private require(): ftWebsocket {
    if (!this.ws) throw new Error('FutuGatewayClient is not connected — call connect() first')
    return this.ws
  }

  private s2c<T>(resp: { s2c?: unknown }, what: string): T {
    if (!resp.s2c) throw new Error(`FutuOpenD ${what} response is missing its s2c payload`)
    return resp.s2c as T
  }
}
