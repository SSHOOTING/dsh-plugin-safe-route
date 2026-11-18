import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_POLICY,
  classify,
  fold,
  formatReport,
  normalizePolicy,
  readRoute,
  redact,
} from '../lib/core.js'

const header = (provider, model) => ({
  type: 'request/header',
  data: { config: { provider, model } },
})
const context = (provider, model) => ({
  type: 'request/context',
  data: { provider, model },
})

test('readRoute reads request/header config', () => {
  assert.deepEqual(readRoute(header('opencode-go', 'hy4-flash-free')), {
    provider: 'opencode-go',
    model: 'hy4-flash-free',
  })
})

test('readRoute reads request/context refresh', () => {
  assert.deepEqual(readRoute(context('opencode-go', 'longcat-2.5-free')), {
    provider: 'opencode-go',
    model: 'longcat-2.5-free',
  })
})

test('readRoute ignores unrelated or malformed events', () => {
  assert.equal(readRoute({ type: 'user/message', data: {} }), null)
  assert.equal(readRoute({ type: 'request/header', data: {} }), null)
  assert.equal(readRoute({ type: 'request/context', data: { provider: 'opencode-go' } }), null)
  assert.equal(readRoute(null), null)
  assert.equal(readRoute('nope'), null)
})

test('classify: deny wins, then allow, then unknown', () => {
  const policy = {
    allow: [{ provider: 'opencode-go' }],
    deny: [{ provider: 'opencode-go', model: 'hy4' }],
  }
  assert.equal(classify({ provider: 'opencode-go', model: 'hy4' }, policy), 'denied')
  assert.equal(classify({ provider: 'opencode-go', model: 'hy4-flash-free' }, policy), 'allowed')
  assert.equal(classify({ provider: 'deepseek-official', model: 'x' }, policy), 'unknown')
})

test('classify supports wildcard rules', () => {
  const policy = { allow: [{ provider: '*', model: '*-free' }] }
  assert.equal(classify({ provider: 'opencode-go', model: 'hy4-flash-free' }, policy), 'allowed')
  assert.equal(classify({ provider: 'any', model: 'longcat-2.5-free' }, policy), 'allowed')
  assert.equal(classify({ provider: 'any', model: 'pro' }, policy), 'unknown')
})

test('normalizePolicy rejects invalid shapes and keeps valid rules', () => {
  assert.deepEqual(normalizePolicy(null), DEFAULT_POLICY)
  assert.deepEqual(normalizePolicy({ allow: [] }), DEFAULT_POLICY)
  assert.deepEqual(normalizePolicy({ allow: [{ nope: 1 }] }), DEFAULT_POLICY)
  assert.deepEqual(normalizePolicy({ allow: [{ provider: 'p', model: 'm', extra: 1 }], deny: 'bad' }), {
    allow: [{ provider: 'p', model: 'm' }],
    deny: [],
  })
})

test('fold reports clean sessions and an empty-session score of 100', () => {
  const empty = fold([])
  assert.equal(empty.calls, 0)
  assert.equal(empty.score, 100)
  assert.equal(empty.verdict, 'clean')

  const clean = fold([
    header('opencode-go', 'hy4-flash-free'),
    context('opencode-go', 'hy4-flash-free'),
    { type: 'turn/start', data: {} },
  ])
  assert.equal(clean.calls, 2)
  assert.equal(clean.allowed, 2)
  assert.equal(clean.score, 100)
  assert.equal(clean.verdict, 'clean')
  assert.equal(clean.sampledEvents, 3)
})

test('fold detects violations and aggregates per route', () => {
  const summary = fold([
    header('opencode-go', 'hy4-flash-free'),
    context('opencode-go', 'hy4-flash-free'),
    header('deepseek-official', 'deepseek-v4-pro'),
    context('opencode-go', 'longcat-2.5-free'),
  ])
  assert.equal(summary.calls, 4)
  assert.equal(summary.allowed, 3)
  assert.equal(summary.denied, 0)
  assert.equal(summary.unknown, 1)
  assert.equal(summary.score, 75)
  assert.equal(summary.verdict, 'review')
  assert.deepEqual(summary.routes.map((r) => [r.provider, r.model, r.calls, r.status]), [
    ['opencode-go', 'hy4-flash-free', 2, 'allowed'],
    ['deepseek-official', 'deepseek-v4-pro', 1, 'unknown'],
    ['opencode-go', 'longcat-2.5-free', 1, 'allowed'],
  ])
})

test('fold uses a deny rule and reports violation', () => {
  const policy = {
    allow: [{ provider: '*' }],
    deny: [{ provider: 'opencode-go', model: 'hy4' }],
  }
  const summary = fold([header('opencode-go', 'hy4'), header('opencode-go', 'hy4-flash-free')], policy)
  assert.equal(summary.score, 50)
  assert.equal(summary.verdict, 'violation')
  assert.equal(summary.routes.find((r) => r.model === 'hy4').status, 'denied')
})

test('formatReport produces text and JSON without leaking secrets', () => {
  const summary = fold([header('opencode-go', 'hy4-flash-free'), header('evil', 'token=abc123')])
  const text = formatReport(summary)
  assert.match(text, /score 50\/100/)
  assert.match(text, /REVIEW/)
  assert.doesNotMatch(text, /abc123/)
  const json = formatReport(summary, { json: true })
  assert.equal(JSON.parse(json).calls, 2)
})

test('redact strips common credential shapes', () => {
  assert.equal(redact('api_key=secret123'), 'api_key=[redacted]')
  assert.equal(redact('https://x.dev/?token=abc&y=1'), 'https://x.dev/?token=[redacted]&y=1')
})
