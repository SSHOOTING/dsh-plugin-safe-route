import { DEFAULT_POLICY, fold, formatReport, normalizePolicy, type Policy } from './core.js'

export const name = 'dsh-plugin-safe-route'

/** The command registry is the only host service we activate. */
export const inject = ['commands']

interface CommandContext {
  commands: {
    register(command: {
      name: string
      description: string
      input?: { hint?: string }
      handler: (args: { agent?: { session?: { events?: readonly unknown[] } }; rawInput?: string }) =>
        | { kind: 'success'; text: string }
        | { kind: 'error'; text: string }
    }): () => void
  }
  /** Cordis lifecycle scope; registers disposables so disable/reload leaves no duplicate command. */
  effect?: (body: () => Generator, label?: string) => void
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
}

/** DSH passes the bundle row's `config` as the second argument to apply(). */
function readPolicy(config: unknown): Policy {
  if (config && typeof config === 'object' && 'policy' in config) {
    return normalizePolicy((config as Record<string, unknown>).policy)
  }
  return DEFAULT_POLICY
}

/**
 * Cordis bundle entry. Registers `/route-check`, a read-only audit of the
 * providers/models used in the current session against a configurable allowlist.
 */
export function apply(ctx: CommandContext, config?: unknown): void {
  const policy = readPolicy(config)

  const dispose = ctx.commands.register({
    name: 'route-check',
    description: 'Audit model routes used in this session against your allowlist',
    input: { hint: '[--json]' },
    handler: ({ agent, rawInput }) => {
      try {
        const events = Array.isArray(agent?.session?.events) ? agent.session.events : []
        const summary = fold(events, policy)
        const json = (rawInput ?? '').trim() === '--json'
        return { kind: 'success', text: formatReport(summary, { json }) }
      } catch (error) {
        return { kind: 'error', text: `[route-check] failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(function* () { yield dispose }, `${name} lifecycle`)
  }

  ctx.logger?.info?.('[dsh-plugin-safe-route] loaded (read-only; /route-check available)')
}
