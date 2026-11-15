/**
 * Round-trip tests for the profile-patch writing path.
 *
 * Everything here is offline: no profile is read or written. The documents are
 * YAML strings, and the "read back" step reproduces dsh's own loader dialect
 * (`entryListSchema`: `!!js` -> `{ __jsExpr }`) with `yaml`'s custom-tag
 * `resolve`, which is what `readProfilePatches` hands the Loader.
 *
 * Run with `npm test` (or `node --test test/`).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from 'yaml'
import { insertRow, parsePatch, removeRow, serializePatch } from '../host/patch-doc.js'
import { McpManager, MCP_CLIENT } from '../host/index.js'

/** dsh's loader dialect: `!!js` resolves to the Loader expression marker. */
const LOADER_DIALECT = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value) => ({ __jsExpr: value }),
}

/**
 * Read patch text the way `readProfilePatches` does.
 * @param {string} text YAML patch text.
 * @returns {object[]} Parsed patch list.
 */
function readBack(text) {
  return parse(text, { customTags: [LOADER_DIALECT] })
}

/** A Context stub with no tools service, enough for `view()`/`configFor()`. */
const CTX = { get: () => undefined }

/** The inserted rows of a parsed patch list. */
function inserted(rows) {
  return rows.flatMap((row) => row.insert ?? [])
}

/** The top-level overrides of a parsed patch list. */
function overrides(rows) {
  return rows.filter((row) => row.insert === undefined)
}

/** A patch that already carries a `!!js` row plus a comment and another plugin. */
const EXISTING = `# user comment kept by every save
- insert:
    - id: some-other-plugin
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: other
        transport: stdio
        command: node
        disabled: !!js process.env.NO_WEB !== '1'
`

test('parse -> insert -> serialize -> read back keeps the row and the other rows', () => {
  const document = parsePatch(EXISTING)
  insertRow(document, {
    id: 'mcp-a',
    name: MCP_CLIENT,
    config: { serverName: 'a', transport: 'stdio', command: 'node', args: ['x.js'] },
  })
  const text = serializePatch(document)
  const rows = readBack(text)

  const all = inserted(rows)
  assert.equal(all.length, 2)
  assert.equal(all[0].id, 'some-other-plugin')
  assert.deepEqual(all[1], {
    id: 'mcp-a',
    name: MCP_CLIENT,
    config: { serverName: 'a', transport: 'stdio', command: 'node', args: ['x.js'] },
  })
  assert.match(text, /^# user comment kept by every save$/m, 'the comment survives')
})

test('!!js expressions survive a save instead of becoming plain strings', () => {
  const document = parsePatch(EXISTING)
  insertRow(document, {
    id: 'mcp-b',
    name: MCP_CLIENT,
    config: { serverName: 'b', transport: 'stdio', command: 'node' },
  })
  const text = serializePatch(document)

  assert.match(text, /!!js process\.env\.NO_WEB !== '1'/, 'written back as a !!js scalar')
  assert.doesNotMatch(text, /__jsExpr/, 'the marker object never reaches the file')

  // This is the finding: a plain `toJS()` reads the expression as a string,
  // which `Boolean()` makes truthy and silently disables the row.
  const dialect = inserted(readBack(text))[0].config.disabled
  assert.deepEqual(dialect, { __jsExpr: "process.env.NO_WEB !== '1'" })
  assert.equal(typeof parse(text)[0].insert[0].config.disabled, 'string', 'a plain parse loses the tag')
})

test('inserting into an empty patch creates the insert list', () => {
  const document = parsePatch('')
  insertRow(document, { id: 'mcp-c', name: MCP_CLIENT, config: { serverName: 'c', transport: 'stdio', command: 'node' } })
  const rows = readBack(serializePatch(document))
  assert.equal(rows.length, 1)
  assert.equal(inserted(rows)[0].id, 'mcp-c')
})

test('remove drops the inserted row and the orphan override it left behind', () => {
  // Shape after "insert a, then edit it": configEditor appends a top-level
  // override because it cannot see inserted rows.
  const document = parsePatch(`- insert:
    - id: mcp-a
      name: '${MCP_CLIENT}'
      config:
        serverName: a
        transport: stdio
        command: v1
- id: mcp-a
  name: '${MCP_CLIENT}'
  config:
    serverName: a
    transport: stdio
    command: v2
- id: keep-me
  config:
    enabled: true
`)

  removeRow(document, { id: 'mcp-a', name: MCP_CLIENT })
  const rows = readBack(serializePatch(document))

  assert.deepEqual(inserted(rows), [], 'the inserted row is gone')
  assert.deepEqual(overrides(rows).map((row) => row.id), ['keep-me'], 'the orphan override is gone, unrelated overrides stay')

  // Re-adding the same server name must not resurrect the old config.
  insertRow(document, { id: 'mcp-a', name: MCP_CLIENT, config: { serverName: 'a', transport: 'stdio', command: 'v3' } })
  const again = readBack(serializePatch(document))
  assert.equal(inserted(again)[0].config.command, 'v3')
  assert.deepEqual(overrides(again).map((row) => row.id), ['keep-me'])
})

test('remove finds a row that lives in an earlier insert block', () => {
  // A patch file may hold several insert blocks; the loader composes them all.
  // Before the fix, insertSequence() returned only the LAST block, so a row in
  // the first block was reported as "not inserted" even though the panel lists it.
  const document = parsePatch(`- insert:
    - id: mcp-first
      name: '${MCP_CLIENT}'
      config: { serverName: first, transport: stdio, command: node }
- insert:
    - id: mcp-second
      name: '${MCP_CLIENT}'
      config: { serverName: second, transport: stdio, command: node }
`)

  removeRow(document, { id: 'mcp-first', name: MCP_CLIENT })
  const rows = readBack(serializePatch(document))
  const ids = inserted(rows).map((row) => row.id)
  assert.deepEqual(ids, ['mcp-second'], 'the first block lost its row, the second is untouched')

  // The first block held only that row, so its now-empty holder is dropped and
  // the second block is left exactly as it was.
  assert.equal(rows.filter((row) => row.insert !== undefined).length, 1, 'only the emptied holder removed')
  assert.equal(rows.filter((row) => row.insert !== undefined)[0].insert[0].id, 'mcp-second')
})

test('remove drops the emptied block and keeps the other one', () => {
  const document = parsePatch(`- insert:
    - id: mcp-solo
      name: '${MCP_CLIENT}'
      config: { serverName: solo, transport: stdio, command: node }
- insert:
    - id: keep-this
      name: '${MCP_CLIENT}'
      config: { serverName: keep, transport: stdio, command: node }
`)
  removeRow(document, { id: 'mcp-solo', name: MCP_CLIENT })
  const rows = readBack(serializePatch(document))
  assert.deepEqual(inserted(rows).map((row) => row.id), ['keep-this'])
  assert.equal(rows.filter((row) => row.insert !== undefined).length, 1, 'the emptied holder is gone')
})

test('remove cleans the override even when the row was in an earlier block', () => {
  const document = parsePatch(`- insert:
    - id: mcp-old
      name: '${MCP_CLIENT}'
      config: { serverName: old, transport: stdio, command: v1 }
- insert:
    - id: unrelated
      name: '${MCP_CLIENT}'
      config: { serverName: other, transport: stdio, command: node }
- id: mcp-old
  name: '${MCP_CLIENT}'
  config: { serverName: old, transport: stdio, command: v2-stale }
`)
  removeRow(document, { id: 'mcp-old', name: MCP_CLIENT })
  const rows = readBack(serializePatch(document))
  assert.deepEqual(inserted(rows).map((row) => row.id), ['unrelated'])
  assert.deepEqual(overrides(rows), [], 'the orphan override is gone too')
})

test('insert refuses a duplicate id in any insert block', () => {
  const document = parsePatch(`- insert:
    - id: mcp-taken
      name: '${MCP_CLIENT}'
      config: { serverName: taken, transport: stdio, command: node }
- insert:
    - id: other
      name: '${MCP_CLIENT}'
      config: { serverName: other, transport: stdio, command: node }
`)
  assert.throws(
    () => insertRow(document, { id: 'mcp-taken', name: MCP_CLIENT, config: { serverName: 'x' } }),
    /already exists/,
    'uniqueness is checked across every block, not just the last',
  )
})

test('insert appends to the last insert block, leaving earlier blocks in place', () => {
  const document = parsePatch(`- insert:
    - id: first
      name: '${MCP_CLIENT}'
      config: { serverName: first, transport: stdio, command: node }
- insert:
    - id: second
      name: '${MCP_CLIENT}'
      config: { serverName: second, transport: stdio, command: node }
`)
  insertRow(document, { id: 'mcp-new', name: MCP_CLIENT, config: { serverName: 'new', transport: 'stdio', command: 'node' } })
  const rows = readBack(serializePatch(document))
  assert.equal(rows.filter((row) => row.insert !== undefined).length, 2, 'still two blocks')
  assert.deepEqual(inserted(rows).map((row) => row.id), ['first', 'second', 'mcp-new'])
})

test('remove keeps a same-id override that names a different plugin', () => {
  const document = parsePatch(`- insert:
    - id: shared
      name: '${MCP_CLIENT}'
      config: { serverName: s }
- id: shared
  name: 'some-other-plugin'
  config: { keep: true }
`)
  removeRow(document, { id: 'shared', name: MCP_CLIENT })
  const rows = readBack(serializePatch(document))
  assert.deepEqual(overrides(rows).map((row) => row.name), ['some-other-plugin'])
})

test('remove refuses a row that is not an inserted row', () => {
  const document = parsePatch('- id: only-override\n  config: {}\n')
  assert.throws(() => removeRow(document, { id: 'only-override' }), /not an inserted profile row/)
})

test('failOnStartupError reaches the config of a brand new row', () => {
  const manager = new McpManager(CTX, {})
  const config = manager.configFor(
    { serverName: 'x', transport: 'stdio', command: 'node', args: ['a'], failOnStartupError: true },
    {},
  )
  assert.equal(config.failOnStartupError, true)
})

test('failOnStartupError is cleared when the checkbox is unticked', () => {
  const manager = new McpManager(CTX, {})
  const config = manager.configFor(
    { serverName: 'x', transport: 'stdio', command: 'node', failOnStartupError: false },
    { failOnStartupError: true },
  )
  assert.equal(config.failOnStartupError, false)
})

test('other preserved fields still come from the existing row', () => {
  const manager = new McpManager(CTX, {})
  const config = manager.configFor(
    { serverName: 'x', transport: 'stdio', command: 'node' },
    { toolCallTimeoutMs: 5000, maxInstructionBytes: 1024, reconnect: { retries: 2 } },
  )
  assert.equal(config.toolCallTimeoutMs, 5000)
  assert.equal(config.maxInstructionBytes, 1024)
  assert.deepEqual(config.reconnect, { retries: 2 })
})

test('a !!js header survives the panel textarea round trip', () => {
  const manager = new McpManager(CTX, {})
  const stored = { Authorization: { __jsExpr: '"Bearer " + process.env.TOKEN' }, 'X-Plain': 'static' }

  // view(): the panel must see readable text, not "[object Object]".
  const view = manager.view({ options: { id: 'r' }, disabled: false }, {
    serverName: 'x',
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    headers: stored,
  })
  assert.deepEqual(view.headers, {
    Authorization: '!!js "Bearer " + process.env.TOKEN',
    'X-Plain': 'static',
  })
  assert.doesNotMatch(JSON.stringify(view.headers), /object Object/)

  // client formatPairs/parsePairs: KEY=VALUE lines split on the first "=" only,
  // so the `!!js ` prefix survives the textarea untouched.
  const text = Object.entries(view.headers).map(([key, value]) => `${key}=${value}`).join('\n')
  const parsed = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf('=')
    parsed[line.slice(0, index)] = line.slice(index + 1)
  }

  // cleanDict(): back to the marker, so the saved YAML keeps the expression.
  const config = manager.configFor(
    { serverName: 'x', transport: 'streamable-http', url: 'https://example.com/mcp', headers: parsed },
    {},
  )
  assert.deepEqual(config.headers, stored)

  // An expression containing "=" still splits on the KEY separator only.
  const equal = manager.configFor(
    { serverName: 'x', transport: 'streamable-http', url: 'https://e/mcp', headers: { H: '!!js process.env.NO_WEB !== "1"' } },
    {},
  )
  assert.deepEqual(equal.headers, { H: { __jsExpr: 'process.env.NO_WEB !== "1"' } })
})

test('a literal !!js-looking string without the prefix stays literal', () => {
  const manager = new McpManager(CTX, {})
  const config = manager.configFor(
    { serverName: 'x', transport: 'streamable-http', url: 'https://e/mcp', headers: { H: 'Bearer abc' } },
    {},
  )
  assert.deepEqual(config.headers, { H: 'Bearer abc' })
})

test('a marker object posted directly survives cleanDict unchanged', () => {
  const manager = new McpManager(CTX, {})
  const config = manager.configFor(
    { serverName: 'x', transport: 'streamable-http', url: 'https://e/mcp', headers: { H: { __jsExpr: 'process.env.T' } } },
    {},
  )
  assert.deepEqual(config.headers, { H: { __jsExpr: 'process.env.T' } })
})

test('an empty expression is dropped rather than saved', () => {
  const manager = new McpManager(CTX, {})
  const config = manager.configFor(
    { serverName: 'x', transport: 'streamable-http', url: 'https://e/mcp', headers: { A: '!!js ', B: 'keep' } },
    {},
  )
  assert.deepEqual(config.headers, { B: 'keep' })
})

test('blank dictionary entries are dropped', () => {
  const manager = new McpManager(CTX, {})
  const config = manager.configFor(
    { serverName: 'x', transport: 'stdio', command: 'node', env: { A: '1', '': '2', B: '  ' } },
    {},
  )
  assert.deepEqual(config.env, { A: '1' })
})
