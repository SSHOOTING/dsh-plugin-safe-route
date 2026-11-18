import test from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, apply } from '../lib/index.js'

function makeCtx() {
  const registered = []
  const logs = []
  return {
    registered,
    logs,
    commands: { register: (command) => registered.push(command) },
    logger: { info: (m) => logs.push(m) },
  }
}

test('entry exports the bundle name and injects only commands', () => {
  assert.equal(name, 'dsh-plugin-safe-route')
  assert.deepEqual(inject, ['commands'])
})

test('apply registers /route-check once', () => {
  const ctx = makeCtx()
  apply(ctx)
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].name, 'route-check')
  assert.match(ctx.logs[0], /loaded/)
})

test('handler audits the session with the patched allowlist from apply(ctx, config)', () => {
  const ctx = makeCtx()
  apply(ctx, { policy: { allow: [{ provider: 'my-provider', model: 'free-1' }] } })
  const command = ctx.registered[0]
  const result = command.handler({
    agent: {
      session: {
        events: [
          { type: 'request/header', data: { config: { provider: 'my-provider', model: 'free-1' } } },
          { type: 'request/header', data: { config: { provider: 'paid-provider', model: 'pro' } } },
        ],
      },
    },
    rawInput: '',
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /score 50\/100/)
  assert.match(result.text, /paid-provider\/pro\s+1 call\(s\)\s+UNKNOWN/)
})

test('handler supports --json and survives missing sessions', () => {
  const ctx = makeCtx()
  apply(ctx)
  const command = ctx.registered[0]
  const json = command.handler({ agent: {}, rawInput: '--json' })
  assert.equal(json.kind, 'success')
  assert.equal(JSON.parse(json.text).calls, 0)
})
