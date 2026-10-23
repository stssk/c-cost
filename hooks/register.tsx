import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionCost, SessionRateLimit } from 'claude-code'

import type { Usage } from '../types'

const usage = atom({ plugin: 'c-cost', key: 'usage' } as const, null)

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

const resetIn = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (mins >= 1440) return ` ↻${Math.round(mins / 1440)}d`
  return mins >= 60 ? ` ↻${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}` : ` ↻${mins}m`
}

const BAR = 10
const FULL = '█'
const EMPTY = '░'
const filled = (pct: number) => Math.min(BAR, Math.max(0, Math.round((pct / 100) * BAR)))
const barColor = (pct: number) => (pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success')

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`

const save = ($: EngineInterface, rateLimits: SessionRateLimit[], cost: SessionCost | undefined) =>
  update($, usage, (): Usage => ({
    rateLimits: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    usd: cost?.usd ?? null,
  }))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const { rateLimits, cost } = await $.session.usage()
    await save($, rateLimits, cost)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await save($, e.rateLimits, e.cost)
    return next(e)
  })

  // Subscription: the windows are what matters, the USD is only notional.
  // API key: no windows come back, so the USD is the real bill.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || u === null || (u.rateLimits.length === 0 && u.usd === null)) return next(e)

    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box justifyContent="flex-end" gap={2}>
        {u.rateLimits.map(w => (
          <Box key={w.kind}>
            <Text color="suggestion" bold>{`${LABELS[w.kind] ?? w.kind} `}</Text>
            <Text color={barColor(w.percentUsed)}>{FULL.repeat(filled(w.percentUsed))}</Text>
            <Text color="inactive">{EMPTY.repeat(BAR - filled(w.percentUsed))}</Text>
            <Text color="text">{` ${w.percentUsed}%`}</Text>
            <Text color="subtle">{resetIn(w.resetsAt, now)}</Text>
          </Box>
        ))}
        {u.usd === null ? null : (
          <Text color="claude">{u.rateLimits.length ? `≈${usd(u.usd)}` : `${usd(u.usd)} this session`}</Text>
        )}
      </Box>
    )
  })
}
