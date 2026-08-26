// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PositionLiveTick } from './PositionLiveTick'

const mocks = vi.hoisted(() => ({ useLiveQuote: vi.fn() }))
vi.mock('../../hooks/useLiveQuote', () => ({ useLiveQuote: mocks.useLiveQuote }))

beforeEach(() => {
  mocks.useLiveQuote.mockReset()
})

afterEach(cleanup)

describe('PositionLiveTick', () => {
  it('renders nothing when the account has no live-quote support', () => {
    mocks.useLiveQuote.mockReturnValue({ status: 'unsupported', quote: null })
    const { container } = render(
      <PositionLiveTick utaId="futu-sim" aliceId="futu-sim|HK.00700" formatFallback={(v) => `$${v}`} />,
    )
    expect(container.textContent).toBe('')
  })

  it('renders nothing while still connecting', () => {
    mocks.useLiveQuote.mockReturnValue({ status: 'connecting', quote: null })
    const { container } = render(
      <PositionLiveTick utaId="futu-sim" aliceId="futu-sim|HK.00700" formatFallback={(v) => `$${v}`} />,
    )
    expect(container.textContent).toBe('')
  })

  it('renders the Live badge and the formatted live price once a quote has arrived', () => {
    mocks.useLiveQuote.mockReturnValue({
      status: 'live',
      quote: { contract: {}, last: '620.5', timestamp: '2026-08-26T00:00:00.000Z' },
    })
    render(<PositionLiveTick utaId="futu-sim" aliceId="futu-sim|HK.00700" formatFallback={(v) => `$${v}`} />)
    expect(screen.getByText('Live')).toBeTruthy()
    expect(screen.getByText('$620.5')).toBeTruthy()
  })

  it('passes the resolved aliceId through to useLiveQuote', () => {
    mocks.useLiveQuote.mockReturnValue({ status: 'unsupported', quote: null })
    render(<PositionLiveTick utaId="futu-sim" aliceId="futu-sim|HK.00700" formatFallback={(v) => v} />)
    expect(mocks.useLiveQuote).toHaveBeenCalledWith('futu-sim', { aliceId: 'futu-sim|HK.00700' })
  })

  it('passes undefined ref to useLiveQuote when the position has no aliceId', () => {
    mocks.useLiveQuote.mockReturnValue({ status: 'unsupported', quote: null })
    render(<PositionLiveTick utaId="futu-sim" formatFallback={(v) => v} />)
    expect(mocks.useLiveQuote).toHaveBeenCalledWith('futu-sim', undefined)
  })
})
