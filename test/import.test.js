import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'
import { apply, McpError, McpManager, MCP_CLIENT } from '../host/index.js'
import { createProfilePatchWriter } from '../host/profile-patch.js'

const entry = (serverName, id = `mcp-${serverName}`, name = MCP_CLIENT) => ({ options: { id, name, config: { serverName } } })
const invalid = (error) => error instanceof McpError && error.code === 'invalid'
const batch = JSON.stringify({ mcpServers: {
  local: { command: ' node ', args: ['', ' script.js '], env: { TOKEN: '!!js process.env.TOKEN', EMPTY: '', ' spaced ': ' value ' }, cwd: ' /tmp ' },
  remote: { type: 'http', url: ' https://example.com/mcp ', headers: { Authorization: '!!js process.env.TOKEN' } },
} })

function manager(entries = [], config = {}) {
  const writes = []
  const ctx = { get: () => undefined, loader: { entries: () => entries } }
  return { entries, writes, instance: new McpManager(ctx, config, { insertMany: async (rows) => { writes.push(rows) } }) }
}

test('preview normalizes a valid batch without writes and preserves literal strings', async () => {
  const { instance, writes } = manager()
  const expected = { servers: [
    { serverName: 'local', transport: 'stdio', command: ' node ', args: ['', ' script.js '], env: { TOKEN: '!!js process.env.TOKEN', EMPTY: '', ' spaced ': ' value ' }, cwd: ' /tmp ' },
    { serverName: 'remote', transport: 'streamable-http', url: ' https://example.com/mcp ', headers: { Authorization: '!!js process.env.TOKEN' } },
  ] }
  assert.deepEqual(instance.previewImport(batch), expected)
  assert.deepEqual(writes, [])
  assert.deepEqual(await instance.importServers(batch), { imported: 2 })
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].map((row) => row.config), expected.servers)
})

test('bare maps, explicit stdio, inferred HTTP and prototype-like names are safe', () => {
  const { instance } = manager()
  assert.deepEqual(instance.previewImport('{"__proto__":{"command":"node"},"constructor":{"type":"stdio","command":"python"},"http":{"url":"https://e/mcp"}}'), { servers: [
    { serverName: '__proto__', transport: 'stdio', command: 'node', args: [] },
    { serverName: 'constructor', transport: 'stdio', command: 'python', args: [] },
    { serverName: 'http', transport: 'streamable-http', url: 'https://e/mcp' },
  ] })
})

test('import rejects payloads over one MiB before parsing', () => {
  const { instance, writes } = manager()
  assert.throws(() => instance.previewImport(' '.repeat(1024 * 1024 + 1)), invalid)
  assert.deepEqual(writes, [])
})

const badInputs = [undefined, null, {}, '', '{', '[]', 'null', '42', '"text"', '{}',
  '{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":{}}', '{"mcpServers":{"a":{"command":"node"}},"extra":true}',
  ...[null, [], 'node', { command: 2 }, { command: '' }, { command: '  ' }, { command: 'node', args: 'a' },
    { command: 'node', args: [1] }, { command: 'node', args: [null] }, { command: 'node', env: [] },
    { command: 'node', env: { N: 1 } }, { command: 'node', env: { N: { __jsExpr: 'bad' } } },
    ...[{ __jsExpr: '(probe.hits++, {})' }, { __jsExpr: '(probe.hits++, {})', TOKEN: 'safe' }].flatMap((dictionary) => [
      { command: 'node', env: dictionary }, { type: 'http', url: 'https://e', headers: dictionary },
    ]),
    { command: 'node', cwd: null }, { type: 'http', url: 1 }, { type: 'http', url: ' ' },
    { type: 'http', url: 'https://e', headers: null }, { type: 'http', url: 'https://e', headers: { H: false } },
    { type: 'sse', url: 'https://e' }, { type: null, command: 'node' }, { type: false, command: 'node' },
    { command: 'node', disabled: false }, { command: 'node', transport: 'stdio' },
    { command: 'node', url: 'https://e' }, { type: 'http', url: 'https://e', command: 'node' },
    { command: 'node', failOnStartupError: true }, { command: 'node', unknown: true },
  ].map((value) => JSON.stringify({ mcpServers: { a: value } })),
  '{"a":{"command":"first"},"a":{"command":"second"}}',
  '{"a":{"command":"first","command":"second"}}',
  '{"a":{"command":"node","env":{"TOKEN":"first","TOKEN":"second"}}}',
  '{"a":{"command":"first"},"\\u0061":{"command":"second"}}',
  ...['', 'has space', 'a.b', 'x'.repeat(33)].map((name) => JSON.stringify({ [name]: { command: 'node' } })),
]

test('invalid JSON, shape, fields, transports and exact types reject the entire batch', async () => {
  const { instance, writes } = manager()
  for (const input of badInputs) {
    assert.throws(() => instance.previewImport(input), invalid, `preview: ${JSON.stringify(input)}`)
    await assert.rejects(instance.importServers(input), invalid, `import: ${JSON.stringify(input)}`)
  }
  await assert.rejects(instance.importServers(JSON.stringify({ good: { command: 'node' }, bad: { command: 'node', disabled: true } })), invalid)
  assert.deepEqual(writes, [])
})

test('preview and commit both reject existing names without writing or editing', async () => {
  const { instance, entries, writes } = manager()
  instance.previewImport(batch)
  entries.push(entry('remote'))
  assert.throws(() => instance.previewImport(batch), invalid)
  await assert.rejects(instance.importServers(batch), invalid)
  assert.deepEqual(writes, [])
})

test('preview and import require manage even for malformed input', async () => {
  const { instance, writes } = manager([], { manage: false })
  const readOnly = (error) => error instanceof McpError && error.code === 'read-only'
  assert.throws(() => instance.previewImport('{'), readOnly)
  await assert.rejects(instance.importServers(batch), readOnly)
  assert.deepEqual(writes, [])
})

test('row IDs avoid loader entries and other rows in the same batch', async () => {
  const { instance, writes } = manager([entry('unrelated', 'mcp-a', 'other-plugin')])
  await instance.importServers('{"a":{"command":"node"},"a-2":{"command":"node"}}')
  assert.deepEqual(writes[0].map((row) => row.id), ['mcp-a-2', 'mcp-a-2-2'])
})

// A fake app-boot module exercises the real writer against a temporary profile.
// No running profile, install or network is touched.
test('batch writer persists once, rechecks under lock and restores all bytes on failure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-import-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bootDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  await mkdir(bootDir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(bootDir, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
  await writeFile(join(bootDir, 'index.js'), `export const state = { calls: [], fail: false, override: undefined, omit: undefined, mounted: [] };
export function loadProfileDirectory() { return {} }
export function readProfilePatches(_bin, _profile, candidate) { return candidate.patches }
export function composeEntries([patches]) {
  return patches.flatMap((patch) => patch.insert ?? []).map((row) =>
    row.id === state.override ? { ...row, disabled: true } : row)
}
export async function reconcileProfilePatches(_root, text, _bin, ids) {
  state.calls.push({ text, ids });
  if (state.fail && ids?.length) throw new Error('activation failed');
  state.mounted = composeEntries([text]).filter((row) => row.id !== state.omit).map((options) => ({ options }));
}
`)
  const { state } = await import(pathToFileURL(join(bootDir, 'index.js')).href)
  const before = '# preserve comment\n- insert:\n    - id: keep\n      name: other-plugin\n      config: { enabled: true }\n'
  const patchPath = join(dir, 'cordis.patch.yml')
  await writeFile(patchPath, before)
  const entries = []
  let locks = 0
  let duringLock = () => {}
  const ctx = {
    root: { loader: { entries: () => state.mounted } }, profileContext: { dir, patchPath, installAnchor: join(dir, 'package.json') },
    loader: { entries: () => entries },
    get: () => ({ runExclusive: async (run) => { locks++; duringLock(); return run() } }),
  }
  const writer = createProfilePatchWriter(ctx)
  const instance = new McpManager(ctx, {}, writer)
  assert.deepEqual(await instance.importServers(batch), { imported: 2 })
  assert.equal(locks, 1)
  assert.equal(state.calls.length, 1, 'one reload for the entire batch')
  assert.deepEqual(state.calls[0].ids, ['mcp-local', 'mcp-remote'])
  const written = await readFile(patchPath, 'utf8')
  const rows = parse(written, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => ({ __jsExpr: value }) }] })[0].insert
  assert.equal(rows.length, 3)
  assert.equal(rows[1].config.env.TOKEN, '!!js process.env.TOKEN')
  assert.equal(rows[2].config.headers.Authorization, '!!js process.env.TOKEN')
  assert.match(written, /^# preserve comment/m)

  // A second process may have written names not yet visible in this Loader.
  await assert.rejects(instance.importServers(batch), invalid)
  assert.equal(await readFile(patchPath, 'utf8'), written)
  assert.equal(state.calls.length, 1)

  await writeFile(patchPath, before)
  duringLock = () => entries.push(entry('remote'))
  await assert.rejects(instance.importServers(batch), { importIssue: { kind: 'duplicate-server', params: { serverName: 'remote' } } })
  assert.equal(await readFile(patchPath, 'utf8'), before)
  assert.equal(state.calls.length, 1)
  duringLock = () => {}
  entries.length = 0

  const row = { id: 'dup', name: MCP_CLIENT, config: { serverName: 'same', transport: 'stdio', command: 'node' } }
  await assert.rejects(writer.insertMany([row, { ...row, id: 'different' }]), /already exists/)
  assert.equal(await readFile(patchPath, 'utf8'), before)
  await assert.rejects(writer.insertMany([row, { ...row, config: { ...row.config, serverName: 'different' } }]), /already exists/)
  assert.equal(await readFile(patchPath, 'utf8'), before)
  assert.equal(state.calls.length, 1, 'validation failures never reach persist')

  await assert.rejects(instance.importServers('{"literal-env":{"command":"node","env":{"__jsExpr":"literal code"}}}'), invalid)
  assert.equal(await readFile(patchPath, 'utf8'), before)
  state.override = 'mcp-local'
  await assert.rejects(instance.importServers(batch), /overridden/)
  assert.equal(await readFile(patchPath, 'utf8'), before)
  assert.equal(state.calls.length, 1)
  state.override = undefined
  await writeFile(patchPath, '- config: { marker: { __jsExpr: literal } }\n')
  assert.throws(() => writer.assertSafeConfigEdit(), /rewrite a literal/)
  await writeFile(patchPath, '- config: { marker: !!js literal }\n')
  assert.doesNotThrow(() => writer.assertSafeConfigEdit())
  await writeFile(patchPath, before)
  const callsBeforeFailure = state.calls.length
  state.fail = true
  const beforeFailure = await readFile(patchPath, 'utf8')
  await assert.rejects(instance.importServers(batch), /activation failed/)
  assert.equal(await readFile(patchPath, 'utf8'), beforeFailure, 'the whole original file is restored')
  assert.equal(state.calls.length, callsBeforeFailure + 2, 'one failed reconcile and one rollback reconcile')
  state.fail = false
  state.omit = 'mcp-local'
  await assert.rejects(instance.importServers(batch), /did not load/)
  assert.equal(await readFile(patchPath, 'utf8'), before)
  state.omit = undefined
  state.fail = true
  assert.equal(join(dir, 'cordis.patch.yml'), patchPath)
  await rm(patchPath)
  await assert.rejects(instance.importServers(batch), /activation failed/)
  await assert.rejects(readFile(patchPath), { code: 'ENOENT' })
})

test('route import actions use text and retain the response envelopes', async () => {
  let route
  const dir = await mkdtemp(join(tmpdir(), 'mcp-import-route-'))
  try {
    apply({
      profileContext: { dir, patchPath: join(dir, 'unused.yml') },
      loader: { entries: () => [entry('existing')] }, get: () => undefined,
      effect: (callback) => callback(),
      connection: { fetch: { register: (value) => { route = value } } },
    })
    const request = (body) => route.fetch(new Request('http://localhost/api/mcp.manager', { method: 'POST', body: JSON.stringify(body) }))
    const preview = await request({ action: 'previewImport', text: batch })
    assert.equal(preview.status, 200)
    assert.deepEqual(await preview.json(), { value: manager().instance.previewImport(batch) })
    const errors = [
      ['{', { kind: 'invalid-json' }],
      ['{"a":{"command":"node","command":"node"}}', { kind: 'duplicate-key' }],
      ['{"existing":{"command":"node"}}', { kind: 'duplicate-server', params: { serverName: 'existing' } }],
      ['{"a":{"type":"sse","url":"https://e"}}', { kind: 'unsupported-transport', params: { serverName: 'a' } }],
      ['{"a":{"command":"node","disabled":true}}', {
        kind: 'unsupported-field', params: { serverName: 'a', field: 'disabled', allowed: 'type, command, args, env, cwd' },
      }],
      ['[]', undefined],
    ]
    for (const [text, importIssue] of errors) {
      const failure = await request({ action: 'import', text })
      assert.equal(failure.status, 400)
      const body = await failure.json()
      assert.equal(body.error.code, 'invalid')
      assert.equal(typeof body.error.message, 'string')
      assert.deepEqual(body.error.importIssue, importIssue)
    }
    await assert.rejects(readFile(join(dir, 'unused.yml')), { code: 'ENOENT' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('add rejects an existing name and edit rejects a stale row id', async () => {
  const { instance, writes } = manager([entry('existing')])
  const draft = { serverName: 'existing', transport: 'stdio', command: 'node' }
  await assert.rejects(instance.save(draft), /already exists/)
  await assert.rejects(instance.save({ ...draft, rowId: 'stale' }), /changed or no longer exists/)
  await assert.rejects(instance.save({ ...draft, serverName: 'missing', rowId: 'stale' }), /changed or no longer exists/)
  assert.deepEqual(writes, [])
})

test('an edit checks the original revision again after the editor acquires its lock', async () => {
  const row = entry('current')
  row.options.config = { serverName: 'current', transport: 'stdio', command: ' node ', args: [''], startupTimeoutMs: 2000, expandTemplates: true }
  let onDisk = { ...row.options.config, env: { UPDATED: 'yes' } }
  let saved
  const ctx = {
    get: () => undefined,
    loader: { entries: () => [row] },
    configEditor: { edit: async (_row, change) => { saved = change(onDisk) } },
  }
  const manager = new McpManager(ctx)
  const { revision, rowId, transport, serverName } = manager.view(row, row.options.config)
  const draft = { revision, rowId, transport, serverName, failOnStartupError: true }
  await assert.rejects(manager.save(draft), /configuration changed/)
  assert.equal(saved, undefined)
  onDisk = row.options.config
  await manager.save(draft)
  assert.deepEqual(saved, { ...onDisk, failOnStartupError: true })
})

test('remove uses the selected row when another server has the same name', async () => {
  const selected = entry('same', 'selected')
  const ctx = { loader: { entries: () => [entry('same', 'first'), selected] }, get: () => undefined }
  const removed = []
  const manager = new McpManager(ctx, {}, { remove: async (row) => removed.push(row) })
  const { serverName, rowId, revision } = manager.view(selected, selected.options.config)
  await manager.remove(serverName, rowId, revision)
  assert.deepEqual(removed, [selected.options])
})
