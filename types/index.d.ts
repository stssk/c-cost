export type Usage = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  usd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'c-cost': { usage: Usage | null }
  }
}
