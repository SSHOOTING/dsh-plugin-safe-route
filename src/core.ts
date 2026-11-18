/**
 * Pure, dependency-free core for dsh-plugin-safe-route.
 *
 * Reads only route metadata from session events (provider + model names).
 * It never reads, stores, or transmits prompts, tool bodies, or file contents.
 */

export interface Route {
  provider: string
  model: string
}

export interface RouteRule {
  provider: string
  /** Omit to match every model on the provider. `*` is a wildcard. */
  model?: string
}

export interface Policy {
  allow: RouteRule[]
  deny?: RouteRule[]
}

export type RouteStatus = 'allowed' | 'denied' | 'unknown'

export interface RouteUse {
  provider: string
  model: string
  calls: number
  status: RouteStatus
}

export interface Summary {
  sampledEvents: number
  calls: number
  allowed: number
  denied: number
  unknown: number
  routes: RouteUse[]
  /** 0–100; 100 means every observed call was on an allowed route. */
  score: number
  verdict: 'clean' | 'review' | 'violation'
}

export const DEFAULT_POLICY: Policy = {
  allow: [
    { provider: 'opencode-go', model: 'hy4-flash-free' },
    { provider: 'opencode-go', model: 'longcat-2.5-free' },
  ],
  deny: [],
}

const SECRET =
  /((?:token|key|secret|password|authorization|bearer)[^\s:=]{0,24}[:=]\s*)[^\s&]+/gi
const QUERY_SECRET = /([?&](?:token|key|secret|password|auth)=)[^&#\s]+/gi

/** Strip credential-looking substrings before anything is printed. */
export function redact(value: unknown): string {
  const text = value instanceof Error ? value.stack || value.message : String(value)
  return text.replace(SECRET, '$1[redacted]').replace(QUERY_SECRET, '$1[redacted]')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Extract a provider/model route from one session event.
 * DSH records the route in `request/header` (`data.config`) and refreshes it in
 * `request/context` (`data.provider` / `data.model`). Any other event yields null.
 */
export function readRoute(event: unknown): Route | null {
  if (!isRecord(event) || !isRecord(event.data)) return null
  const data = event.data

  if (event.type === 'request/header') {
    if (!isRecord(data.config)) return null
    const config = data.config
    if (typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
    return null
  }

  if (event.type === 'request/context') {
    if (typeof data.provider === 'string' && typeof data.model === 'string') {
      return { provider: data.provider, model: data.model }
    }
  }

  return null
}

/** Glob-style match where `*` stands for any substring. */
function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return value === pattern
  const parts = pattern.split('*')
  let cursor = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === '') continue
    if (i === 0) {
      if (!value.startsWith(part)) return false
      cursor = part.length
    } else if (i === parts.length - 1) {
      if (!value.endsWith(part) || value.length < cursor + part.length) return false
    } else {
      const found = value.indexOf(part, cursor)
      if (found === -1) return false
      cursor = found + part.length
    }
  }
  return true
}

function matches(route: Route, rule: RouteRule): boolean {
  if (!wildcardMatch(route.provider, rule.provider)) return false
  if (rule.model === undefined) return true
  return wildcardMatch(route.model, rule.model)
}

function ruleList(value: unknown): RouteRule[] {
  if (!Array.isArray(value)) return []
  const out: RouteRule[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.provider !== 'string') continue
    const rule: RouteRule = { provider: item.provider }
    if (typeof item.model === 'string') rule.model = item.model
    out.push(rule)
  }
  return out
}

/** Normalize untrusted config into a Policy; invalid shapes fall back to defaults. */
export function normalizePolicy(value: unknown): Policy {
  if (!isRecord(value)) return DEFAULT_POLICY
  const allow = ruleList(value.allow)
  if (allow.length === 0) return DEFAULT_POLICY
  return { allow, deny: ruleList(value.deny) }
}

/** Deny wins over allow; allow wins over unmatched. */
export function classify(route: Route, policy: Policy = DEFAULT_POLICY): RouteStatus {
  if ((policy.deny ?? []).some((rule) => matches(route, rule))) return 'denied'
  if (policy.allow.some((rule) => matches(route, rule))) return 'allowed'
  return 'unknown'
}

const SEVERITY: Record<RouteStatus, number> = { allowed: 0, unknown: 1, denied: 2 }

/** Fold a session event log into a route-compliance summary. */
export function fold(events: readonly unknown[], policy: Policy = DEFAULT_POLICY): Summary {
  const rows = new Map<string, RouteUse>()
  let sampledEvents = 0

  for (const event of events) {
    sampledEvents++
    const route = readRoute(event)
    if (!route) continue
    const key = `${route.provider}\u0000${route.model}`
    const status = classify(route, policy)
    const existing = rows.get(key)
    if (existing) {
      existing.calls++
      if (SEVERITY[status] > SEVERITY[existing.status]) existing.status = status
    } else {
      rows.set(key, { provider: route.provider, model: route.model, calls: 1, status })
    }
  }

  const routes = [...rows.values()].sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider))
  const sum = (status: RouteStatus) =>
    routes.reduce((total, row) => total + (row.status === status ? row.calls : 0), 0)
  const calls = routes.reduce((total, row) => total + row.calls, 0)
  const allowed = sum('allowed')
  const denied = sum('denied')
  const unknown = sum('unknown')
  const score = calls === 0 ? 100 : Math.round((100 * allowed) / calls)
  const verdict: Summary['verdict'] = denied > 0 ? 'violation' : unknown > 0 ? 'review' : 'clean'

  return { sampledEvents, calls, allowed, denied, unknown, routes, score, verdict }
}

/** Compact, shareable text report. Only route names are printed. */
export function formatReport(summary: Summary, options: { json?: boolean } = {}): string {
  if (options.json) return JSON.stringify(summary, null, 2)

  const label = summary.verdict.toUpperCase()
  const head = `[route-check] ${summary.calls - summary.allowed}/${summary.calls} calls outside allowlist ` +
    `· score ${summary.score}/100 · ${label}`
  if (summary.routes.length === 0) {
    return `${head}\n  no model calls observed in this session yet`
  }
  const lines = summary.routes.map(
    (row) => `  ${redact(row.provider)}/${redact(row.model)}  ${row.calls} call(s)  ${row.status.toUpperCase()}`,
  )
  const tip = summary.verdict === 'clean'
    ? ''
    : '\nFix: switch the default model to an allowed route, or update the allowlist in cordis.patch.yml.'
  return [head, ...lines].join('\n') + tip
}
