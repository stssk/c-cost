// The account's spend this billing month, as `/usage` reads it from claude.ai
// (`extra_usage`): the usage-based spend of a Team or Enterprise seat, or a
// Pro/Max plan's usage credits. Amounts in major units of `currency`.
export type AccountSpend = {
  used: number
  limit: number | null
  percentUsed: number | null
  currency: string
}

export type Usage = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  usd: number | null
  monthUsd: number | null
  // Absent in values an earlier version stored: read as null.
  account?: AccountSpend | null
}

declare module 'claude-code' {
  interface PluginState {
    'c-cost': { usage: Usage | null }
  }
}
