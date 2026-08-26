/**
 * Small "LIVE" pill shown next to a quote that's arriving via broker push
 * (not the vendor's 60s-polled snapshot). Kept separate from
 * `LiveIndicator` (which already covers "updated Xs ago" for polled
 * surfaces) rather than folding push-vs-poll semantics into that shared
 * primitive — the two communicate different things and callers that only
 * poll should never need to think about this one.
 */
export function LiveQuoteBadge({ className }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success bg-success/15 ${className ?? ''}`}
      title="Live broker quote — not the vendor-delayed snapshot"
    >
      <span className="relative inline-block w-1.5 h-1.5 rounded-full bg-success live-pulse" aria-hidden />
      Live
    </span>
  )
}
