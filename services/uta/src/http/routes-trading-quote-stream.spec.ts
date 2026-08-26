import { describe, expect, it, vi } from 'vitest'
import { createTradingRoutes } from './routes-trading.js'
import type { UTAEngineContext } from '../types.js'

// ==================== Test harness ====================
//
// Mirrors routes-trading-wallet.spec.ts's makeRoutes shape — a bare object
// standing in for UnifiedTradingAccount, exercised through Hono's
// app.request() (a real Response with a real ReadableStream body, not a
// mocked Context). This is the level sse-transport.spec.ts's own comment
// calls out as the gap unit tests miss: the actual HTTP transport, here
// specifically this route's account-resolution/501/400 branching plus the
// real SSE frame format for a pushed quote.

function makeRoutes(uta: unknown) {
  const ctx = {
    utaManager: {
      get: (id: string) => (id === 'mock-uta' ? uta : undefined),
    },
    snapshotService: undefined,
  } as unknown as UTAEngineContext
  return createTradingRoutes(ctx)
}

/** Let already-queued microtasks (e.g. an async mock's own `await`) settle
 *  before asserting on their side effects — safer than asserting immediately
 *  after `app.request()` resolves, since `streamSSE`'s callback keeps running
 *  in the background rather than being awaited by the response promise. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function readOneChunk(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  await reader.cancel().catch(() => {})
  return new TextDecoder().decode(value)
}

describe('GET /uta/:id/quote-stream (SSE)', () => {
  it('404s for an unknown account', async () => {
    const app = makeRoutes(undefined)
    const res = await app.request('/uta/mock-uta/quote-stream?symbol=AAPL')
    expect(res.status).toBe(404)
  })

  it('501s when the account has no live-quote support, with a polling hint', async () => {
    const app = makeRoutes({ supportsLiveQuote: false })
    const res = await app.request('/uta/mock-uta/quote-stream?symbol=AAPL')
    expect(res.status).toBe(501)
    await expect(res.json()).resolves.toMatchObject({ hint: expect.stringMatching(/polling/i) })
  })

  it('400s when neither symbol nor aliceId is supplied', async () => {
    const app = makeRoutes({ supportsLiveQuote: true })
    const res = await app.request('/uta/mock-uta/quote-stream')
    expect(res.status).toBe(400)
  })

  it('streams a pushed quote update as an SSE "quote" frame', async () => {
    let capturedOnUpdate: ((u: unknown) => void) | null = null
    const unsubscribe = vi.fn(async () => {})
    const subscribeQuote = vi.fn(async (_contract: unknown, onUpdate: (u: unknown) => void) => {
      capturedOnUpdate = onUpdate
      return unsubscribe
    })
    const app = makeRoutes({ supportsLiveQuote: true, subscribeQuote })

    const res = await app.request('/uta/mock-uta/quote-stream?symbol=AAPL')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)

    await flushMicrotasks()
    expect(subscribeQuote).toHaveBeenCalledTimes(1)
    expect(capturedOnUpdate).not.toBeNull()

    capturedOnUpdate!({ contract: { symbol: 'AAPL' }, last: '150.5', timestamp: '2026-08-26T00:00:00.000Z' })

    const frame = await readOneChunk(res)
    expect(frame).toContain('event: quote')
    expect(frame).toContain('150.5')
  })

  it('emits an "error" frame and unsubscribes nothing when subscribeQuote itself throws', async () => {
    const app = makeRoutes({
      supportsLiveQuote: true,
      subscribeQuote: vi.fn(async () => { throw new Error('not entitled for real-time quotes') }),
    })
    const res = await app.request('/uta/mock-uta/quote-stream?symbol=AAPL')
    expect(res.status).toBe(200) // SSE headers are already committed before the subscribe attempt

    const frame = await readOneChunk(res)
    expect(frame).toContain('event: error')
    expect(frame).toContain('not entitled')
  })

  it('accepts aliceId as an alternative to symbol', async () => {
    const subscribeQuote = vi.fn(async (_contract: { aliceId?: string }, _onUpdate: (u: unknown) => void) => vi.fn(async () => {}))
    const app = makeRoutes({ supportsLiveQuote: true, subscribeQuote })
    const res = await app.request('/uta/mock-uta/quote-stream?aliceId=mock-paper%7CAAPL')
    expect(res.status).toBe(200)
    await flushMicrotasks()
    expect(subscribeQuote).toHaveBeenCalledTimes(1)
    const [passedContract] = subscribeQuote.mock.calls[0]
    expect(passedContract.aliceId).toBe('mock-paper|AAPL')
  })
})
