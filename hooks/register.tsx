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

const bar = (pct: number) => ({ full: FULL.repeat(filled(pct)), empty: EMPTY.repeat(BAR - filled(pct)), color: barColor(pct) })

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`

type Month = { sessions: Record<string, number> }

const monthKey = (now: number) => {
  const d = new Date(now)
  return `month:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Each session's cost is cumulative, so it is kept per session id and the
// month is their sum: a session measured twice is never counted twice.
const recordMonth = async ($: EngineInterface, usd: number) => {
  const key = monthKey(await $.clock.now())
  const month = ((await $.store.get(key)) as Month | undefined) ?? { sessions: {} }
  month.sessions[await $.session.id()] = usd
  await $.store.set(key, month)
  return Object.values(month.sessions).reduce((a, b) => a + b, 0)
}

// Subscription windows; any other window (a spend limit) means the USD is real.
const isSubscription = (rateLimits: readonly { kind: string }[]) =>
  rateLimits.some(w => w.kind === 'five_hour' || w.kind === 'seven_day')

const save = async ($: EngineInterface, rateLimits: SessionRateLimit[], cost: SessionCost | undefined) => {
  // Only an API key's spend is real money; on a subscription it is notional.
  const monthUsd = !isSubscription(rateLimits) && cost ? await recordMonth($, cost.usd) : null
  await update($, usage, (): Usage => ({
    rateLimits: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    usd: cost?.usd ?? null,
    monthUsd,
  }))
}

export const register: Register = (on, options) => {
  const limit = Number(options.monthlyLimitUsd ?? 0)

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

  // /clear starts a new session with no `session.start`: drop the old one's
  // figures, so the line waits for the new session's first measure.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, usage, () => null)
    return next(e)
  })

  // Subscription: the windows are what matters, the USD is only notional.
  // API key: the session's USD, and the month against its spend limit: the
  // engine's `spend_limit` reading (what /usage shows) when it reports one,
  // else this machine's own monthly total against `monthlyLimitUsd`.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || u === null || (u.rateLimits.length === 0 && u.usd == null)) return next(e)

    const now = await $.clock.now()
    const isSub = isSubscription(u.rateLimits)
    const spend = u.rateLimits.find(w => w.kind === 'spend_limit')
    const windows = u.rateLimits.filter(w => w !== spend)
    const monthPct = spend ? spend.percentUsed : limit > 0 && u.monthUsd != null ? (u.monthUsd / limit) * 100 : null
    const monthText = spend
      ? ` ${spend.percentUsed}%` + (limit > 0 ? ` ≈${usd((spend.percentUsed / 100) * limit)} / ${usd(limit)}` : '')
      : u.monthUsd == null
        ? null
        : ` ${usd(u.monthUsd)}` + (limit > 0 ? ` / ${usd(limit)} (${Math.round(monthPct ?? 0)}%)` : '')
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box justifyContent="flex-end" gap={2}>
        {windows.map(w => (
          <Box key={w.kind}>
            <Text color="suggestion" bold>{`${LABELS[w.kind] ?? w.kind} `}</Text>
            <Text color={bar(w.percentUsed).color}>{bar(w.percentUsed).full}</Text>
            <Text color="inactive">{bar(w.percentUsed).empty}</Text>
            <Text color="text">{` ${w.percentUsed}%`}</Text>
            <Text color="subtle">{resetIn(w.resetsAt, now)}</Text>
          </Box>
        ))}
        {u.usd == null ? null : isSub ? (
          <Text color="claude">{`≈${usd(u.usd)}`}</Text>
        ) : (
          <Box key="session">
            <Text color="suggestion" bold>{'session '}</Text>
            <Text color="claude">{usd(u.usd)}</Text>
          </Box>
        )}
        {isSub || monthText === null ? null : (
          <Box key="month">
            <Text color="suggestion" bold>{'month '}</Text>
            {monthPct === null ? null : <Text color={bar(monthPct).color}>{bar(monthPct).full}</Text>}
            {monthPct === null ? null : <Text color="inactive">{bar(monthPct).empty}</Text>}
            <Text color="text">{monthText}</Text>
            {spend ? <Text color="subtle">{resetIn(spend.resetsAt, now)}</Text> : null}
          </Box>
        )}
      </Box>
    )
  })
}
