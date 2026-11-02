import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

const BAND = {
  plugin: 'c-cost',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// What claude.ai's usage endpoint answers for a usage-billed Enterprise seat.
const ENTERPRISE = JSON.stringify({
  five_hour: null,
  seven_day: null,
  extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 27140, utilization: null, currency: 'USD' },
})

// Nothing sits beneath the plugin: each hook here stands for the engine.
type On = Parameters<Parameters<typeof test>[1]>[1]
type $ = Parameters<Parameters<typeof test>[1]>[0]

const engine = (on: On, body: string | null) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-02T12:00:00Z') })
  mock.store(on)
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0.432 } },
  }))
  on('session.authorize', () => ({ value: body === null ? null : { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: body ?? '' } }))
  return clock
}

const monthText = async ($: $, clock: MockClock) => {
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const row = await ui.find({ type: 'Text', text: /spent| \/ / })
  await ui.unmount()
  return row?.text
}

test('an Enterprise seat shows the month spend /usage shows', async ($, on) => {
  const clock = engine(on, ENTERPRISE)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await monthText($, clock)).toBe(' $271.40 spent')
})

test('a spend limit from the account draws against it', async ($, on) => {
  const clock = engine(
    on,
    JSON.stringify({
      extra_usage: { is_enabled: true, monthly_limit: 50000, used_credits: 12500, utilization: 25, currency: 'USD' },
    }),
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(await monthText($, clock)).toBe(' $125.00 / $500.00')
})

test('without a claude.ai login the machine total stands', async ($, on) => {
  const clock = engine(on, null)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /spent/ }))?.text).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /\$0\.432/ }))?.text).toBeDefined()
  await ui.unmount()
})
