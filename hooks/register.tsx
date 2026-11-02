import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionCost, SessionRateLimit } from 'claude-code'

import type { AccountSpend, Usage } from '../types'

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
const money = (n: number, currency: string) => (currency.toUpperCase() === 'USD' ? usd(n) : `${n.toFixed(2)} ${currency}`)

// The first of next month, local time: when `/usage` says the month's spend resets.
const nextMonth = (now: number) => {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString()
}

// The account's spend this month, read where `/usage` reads it: claude.ai's
// usage endpoint, its `extra_usage` block (amounts in cents). The engine sets
// the session's own OAuth credential on the request; the plugin never sees it.
// Null off a claude.ai login (an API key, a gateway, a cloud provider) or
// where the plan has no extra usage turned on, as `/usage` shows nothing then.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

type ExtraUsage = {
  is_enabled?: boolean
  monthly_limit?: number | null
  used_credits?: number | null
  utilization?: number | null
  currency?: string | null
}

const fetchAccount = async ($: EngineInterface): Promise<AccountSpend | null> => {
  const auth = await $.session.authorize()
  if (auth === null || auth.kind !== 'bearer') return null
  const res = await $.http.fetch(USAGE_URL, {
    auth: auth.handle,
    headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
  })
  if (!res.ok) throw new Error(`GET /api/oauth/usage: ${res.status}`)
  const x = (JSON.parse(res.text) as { extra_usage?: ExtraUsage | null }).extra_usage
  if (!x || x.is_enabled !== true || typeof x.used_credits !== 'number') return null
  const used = x.used_credits / 100
  const limit = typeof x.monthly_limit === 'number' ? x.monthly_limit / 100 : null
  const percentUsed =
    typeof x.utilization === 'number' ? x.utilization : limit !== null && limit > 0 ? (used / limit) * 100 : null
  return { used, limit, percentUsed, currency: x.currency ?? 'USD' }
}

// At most one read a minute: the line updates after every turn, and the
// server's figure moves slower than that anyway.
const REFRESH_MS = 60_000
let lastFetchAt = 0

const refreshAccount = async ($: EngineInterface, force = false) => {
  const now = await $.clock.now()
  if (!force && now - lastFetchAt < REFRESH_MS) return
  lastFetchAt = now
  try {
    const account = await fetchAccount($)
    await update($, usage, u => (u === null ? u : { ...u, account }))
  } catch (err) {
    $.ui.log(`c-cost: account usage unavailable: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

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
  await update($, usage, (prev): Usage => ({
    rateLimits: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    usd: cost?.usd ?? null,
    monthUsd,
    account: prev?.account ?? null,
  }))
}

export const register: Register = (on, options) => {
  const limit = Number(options.monthlyLimitUsd ?? 0)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const { rateLimits, cost } = await $.session.usage()
    await save($, rateLimits, cost)
    void refreshAccount($, true)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await save($, e.rateLimits, e.cost)
    if (e.changed.includes('cost')) void refreshAccount($)
    return next(e)
  })

  // /clear starts a new session with no `session.start`: drop the old one's
  // figures, so the line waits for the new session's first measure.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, usage, () => null)
    return next(e)
  })

  // Subscription: the windows are what matters, the USD is only notional.
  // API key or a usage-billed seat: the session's USD, and the month: the
  // engine's `spend_limit` reading (a gateway's), else the account's spend
  // from claude.ai (what /usage shows on Team and Enterprise), else this
  // machine's own monthly total against `monthlyLimitUsd`.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    const acct = u?.account ?? null
    if (e.props.hasSurvey || u === null || (u.rateLimits.length === 0 && u.usd == null && acct === null)) return next(e)

    const now = await $.clock.now()
    const isSub = isSubscription(u.rateLimits)
    const spend = u.rateLimits.find(w => w.kind === 'spend_limit')
    const windows = u.rateLimits.filter(w => w !== spend)
    // On a subscription the account's spend is its usage credits: shown once any is spent.
    const account = acct !== null && (!isSub || acct.used > 0) ? acct : null
    const acctLimit = account ? (account.limit ?? (limit > 0 ? limit : null)) : null
    const monthPct = spend
      ? spend.percentUsed
      : account
        ? (account.percentUsed ?? (acctLimit ? (account.used / acctLimit) * 100 : null))
        : limit > 0 && u.monthUsd != null
          ? (u.monthUsd / limit) * 100
          : null
    const monthText = spend
      ? ` ${spend.percentUsed}%` + (limit > 0 ? ` ≈${usd((spend.percentUsed / 100) * limit)} / ${usd(limit)}` : '')
      : account
        ? ` ${money(account.used, account.currency)}` +
          (acctLimit ? ` / ${money(acctLimit, account.currency)}` : ' spent')
        : u.monthUsd == null
          ? null
          : ` ${usd(u.monthUsd)}` + (limit > 0 ? ` / ${usd(limit)} (${Math.round(monthPct ?? 0)}%)` : '')
    const monthResets = spend ? spend.resetsAt : account ? nextMonth(now) : undefined
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
        {(isSub && !account) || monthText === null ? null : (
          <Box key="month">
            <Text color="suggestion" bold>{'month '}</Text>
            {monthPct === null ? null : <Text color={bar(monthPct).color}>{bar(monthPct).full}</Text>}
            {monthPct === null ? null : <Text color="inactive">{bar(monthPct).empty}</Text>}
            <Text color="text">{monthText}</Text>
            {monthResets ? <Text color="subtle">{resetIn(monthResets, now)}</Text> : null}
          </Box>
        )}
      </Box>
    )
  })
}
