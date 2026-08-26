/**
 * Hand-written ambient types for the untyped `futu-api` npm package.
 *
 * The SDK ships plain ESM JavaScript (`main.js` / `base.js` / `proto.js`)
 * with no `.d.ts`. Only the surface FutuGatewayClient actually consumes is
 * declared here; every response body is left as the generic envelope shape
 * (`retType` / `retMsg` / `s2c`) that `_sendCmd` resolves with, and the
 * caller narrows `s2c` via the interfaces in `futu-types.ts`.
 */

declare module 'futu-api' {
  export interface FtCmdEntry { cmd: number; name: string; description: string }
  export const ftCmdID: Record<string, FtCmdEntry>

  export interface FtResponseEnvelope {
    retType?: number
    retMsg?: string
    errCode?: number
    s2c?: unknown
  }

  export default class ftWebsocket {
    onlogin: ((ret: boolean, msg?: unknown) => void) | null
    onPush: ((cmd: number, response: unknown) => void) | null
    /**
     * The underlying ftWebsocketBase transport (assigned by start()). Exposed
     * because the wrapper class does NOT forward the base's onclose/onerror
     * user hooks (base.js invokes `this.onclose(e)` / `this.onerror(e)` when
     * assigned) — connection-loss detection has to attach here. The base also
     * auto-reconnects on a non-deliberate close and re-fires onlogin(true)
     * after the re-handshake succeeds.
     */
    websock: {
      onclose: ((e: unknown) => void) | null
      onerror: ((e: unknown) => void) | null
    } | null
    start(ip: string, port: number, ssl: boolean, key?: string | null): void
    stop(): void
    getConnID(): number
    GetGlobalState(req: unknown): Promise<FtResponseEnvelope>
    GetAccList(req: unknown): Promise<FtResponseEnvelope>
    GetFunds(req: unknown): Promise<FtResponseEnvelope>
    GetPositionList(req: unknown): Promise<FtResponseEnvelope>
    GetSecuritySnapshot(req: unknown): Promise<FtResponseEnvelope>
    GetStaticInfo(req: unknown): Promise<FtResponseEnvelope>
    Sub(req: unknown): Promise<FtResponseEnvelope>
    UnlockTrade(req: unknown): Promise<FtResponseEnvelope>
    PlaceOrder(req: unknown): Promise<FtResponseEnvelope>
    ModifyOrder(req: unknown): Promise<FtResponseEnvelope>
    GetOrderList(req: unknown): Promise<FtResponseEnvelope>
    GetHistoryOrderList(req: unknown): Promise<FtResponseEnvelope>
    SubAccPush(req: unknown): Promise<FtResponseEnvelope>
    RequestHistoryKL(req: unknown): Promise<FtResponseEnvelope>
    GetOrderFee(req: unknown): Promise<FtResponseEnvelope>
  }
}