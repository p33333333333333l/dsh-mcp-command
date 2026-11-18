import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { McpManager } from '../host/index.js'

// Exercise the shipped client functions without mounting React or writing a profile.
let client
let respond
const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const instrumented = source.replace(
  "return { inject: ['slots', 'locale'], apply }",
  'return { parsePairs, formatPairs, importErrorMessage, call, zh, en }',
)
assert.notEqual(instrumented, source)
vm.runInNewContext(instrumented, {
  fetch: (...args) => respond(...args),
  window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(() => ({})) } } },
})

for (const field of ['headers', 'env']) {
  test(`multiline !!js ${field} survive the real panel round trip`, () => {
    const manager = new McpManager({ get: () => undefined, loader: { entries: () => [] } }, {})
    const stored = {
      TOKEN: { __jsExpr: '(() => {\n  const token = process.env.TOKEN;\n  // Keep the newline after this comment.\n  return "Bearer " + token;\n})()' },
      PLAIN: 'static=value',
    }
    const config = { serverName: 'x', transport: field === 'env' ? 'stdio' : 'streamable-http', command: 'node', url: 'https://example.com/mcp', [field]: stored }
    const view = manager.view({ options: { id: 'r' }, disabled: false }, config)
    const parsed = client.parsePairs(client.formatPairs(view[field]))
    const saved = manager.configFor({ ...config, [field]: parsed }, {})
    assert.deepEqual(saved[field], stored)
  })
  test(`imported literal !!js ${field} remain literal after the real panel round trip`, () => {
    const manager = new McpManager({ get: () => undefined, loader: { entries: () => [] } }, {})
    const literal = '!!js (probe.hits++, "executed")'
    const imported = manager.previewImport(JSON.stringify({ x: {
      ...(field === 'env' ? { command: 'node' } : { url: 'https://example.com/mcp' }),
      [field]: { TOKEN: literal, ' spaced ': ` ${literal} `, EMPTY: '' },
    } })).servers[0]
    const view = manager.view({ options: { id: 'r' }, disabled: false }, imported)
    const parsed = client.parsePairs(client.formatPairs(view[field]))
    const saved = manager.configFor({ ...view, [field]: parsed, failOnStartupError: true }, imported)
    assert.deepEqual(saved[field], imported[field])
    assert.equal(typeof saved[field].TOKEN, 'string')
    assert.equal(saved.failOnStartupError, true)
  })
}

test('ordinary pair lines still split on the first equals sign', () => {
  const parsed = client.parsePairs(' A = one=two\n\nB=three\nignored')
  assert.deepEqual({ ...parsed }, { A: 'one=two', B: 'three' })
})

test('import error feedback uses both dictionaries and falls back for unknown errors', () => {
  for (const dictionary of [client.zh, client.en]) {
    const t = (key, params = {}) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => params[name])
    const message = 'backend fallback'
    for (const [kind, params, expected] of [
      ['invalid-json', {}, /JSON/],
      ['duplicate-key', {}, /JSON/],
      ['duplicate-server', { serverName: 'demo' }, /demo/],
      ['unsupported-transport', { serverName: 'demo' }, /demo.*stdio.*streamable-http/],
      ['unsupported-field', { serverName: 'demo', field: 'disabled', allowed: 'type, url, headers' }, /demo.*disabled.*type, url, headers/],
    ]) {
      assert.match(client.importErrorMessage(t, { message, importIssue: { kind, params } }), expected)
    }
    assert.equal(client.importErrorMessage(t, { message }), message)
    assert.equal(client.importErrorMessage(t, { message, importIssue: { kind: 'unknown' } }), message)
  }
})

test('the panel converts malformed responses to a recoverable error', async () => {
  for (const body of ['', '{}', 'null', '{"value":null}', '{"value":{"manage":true}}']) {
    respond = async () => new Response(body)
    assert.equal((await client.call({ action: 'list' })).ok, false, body)
  }
  respond = async () => Response.json({ value: { manage: true, servers: [] } })
  assert.equal((await client.call({ action: 'list' })).ok, true)
})

test('a special but valid environment key survives viewing and editing pairs', () => {
  const manager = new McpManager({ get: () => undefined })
  const stored = JSON.parse('{"__proto__":"literal"}')
  const config = { serverName: 'x', transport: 'stdio', command: 'node', env: stored }
  const view = manager.view({ options: { id: 'r' } }, config)
  const env = client.parsePairs(client.formatPairs(view.env))
  env.OTHER = 'new'
  assert.deepEqual(manager.configFor({ ...config, env }, config).env, { ...stored, OTHER: 'new' })
})
