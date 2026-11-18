/**
 * Host half of the MCP manager.
 *
 * The `/mcp` panel in the browser talks to this plugin over one exact Fetch
 * route (`/api/mcp.manager`) registered on `ctx.connection`. That seam carries
 * browser authentication and works over both the Web carrier and the Desktop
 * IPC bridge, so the browser half needs no generated Remote artifact and no
 * `ctx.remote.<namespace>` service — the mistake that broke the previous boot.
 *
 * Writes go through `ctx.configEditor` (field update of an existing row) or the
 * profile patch writer (row insert/remove), so every change takes the Loader's
 * normal reconcile path.
 *
 * @module dsh-mcp-servers
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseDocument } from 'yaml'
import { createProfilePatchWriter } from './profile-patch.js'

/** Module name of one MCP server row. */
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/**
 * Exact Fetch route the panel posts to.
 *
 * `connection.rpc.handle` is unusable from a plugin: its route registration reads
 * `owner.webServer` on the Connection service's own Context, which carries no
 * `webServer` inject, so it throws `cannot get property "webServer" without
 * inject`. An exact Fetch route registers into the same dispatch table without
 * touching `webServer`, and the shipped `session-log-export` uses this seam.
 */
const ROUTE = '/api/mcp.manager'

/** `serverName` contract from `@deepseek-ai/dsh-mcp-client`. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

function revisionOf(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

/** Fields replaced by the panel when saving transport settings. */
const TRANSPORT_FIELDS = ['command', 'args', 'cwd', 'env', 'url', 'headers']

/** Prefix the panel shows in front of a `!!js` expression. */
const JS_PREFIX = '!!js '

/** Whether a value is a Loader expression marker (`{ __jsExpr }`). */
function isJsExpr(value) {
  return value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string'
}

/** Render one dictionary value for the panel, keeping `!!js` expressions readable. */
function renderValue(value) {
  return isJsExpr(value) ? `${JS_PREFIX}${value.__jsExpr}` : String(value ?? '')
}

/**
 * Restore one panel-entered dictionary value: a leading `!!js ` marks the value
 * as a Loader expression again, so the header round-trips as an expression
 * instead of being saved as the literal text the panel displayed.
 */
function restoreValue(text) {
  const trimmed = text.trim()
  // A bare `!!js` (the panel's own text for an empty expression) matches too, so
  // the caller drops it instead of saving a header literally named `!!js`.
  const expression = /^!!js(?:[ \t]+([\s\S]*))?$/.exec(trimmed)
  return expression === null ? trimmed : { __jsExpr: expression[1] ?? '' }
}

/** Trim a dictionary, dropping blank keys and values. */
function cleanDict(input, previous = {}) {
  const out = Object.create(null)
  if (input !== null && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      const name = String(key).trim()
      // The panel trims pair lines. Keep matching raw literals (including !!js)
      // rather than interpreting imported text when an unrelated field is edited.
      const literal = Object.entries(previous ?? {}).find(([oldKey, oldValue]) =>
        oldKey.trim() === name && typeof oldValue === 'string' &&
        typeof value === 'string' && oldValue.trim() === value.trim())
      if (name !== '' && literal !== undefined) {
        out[literal[0]] = literal[1]
        continue
      }
      // A caller that posts the marker object directly keeps it; the panel posts
      // the `!!js <expr>` text form, which `restoreValue` turns back into one.
      const kept = isJsExpr(value) ? value : restoreValue(String(value ?? '').trim())
      const blank = typeof kept === 'string' ? kept === '' : kept.__jsExpr === ''
      if (name !== '' && !blank) out[name] = kept
    }
  }
  return { ...out }
}

/** Panel-visible copy of one dictionary, with `!!js` expressions rendered as text. */
function viewDict(input) {
  return input !== null && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).map(([key, value]) => [key, renderValue(value)]))
    : {}
}

/** Trim a string list. */
function cleanList(input) {
  return Array.isArray(input) ? input.map((item) => String(item)).filter((item) => item !== '') : []
}

/** A panel operation failure carrying a stable code. */
class McpError extends Error {
  /**
   * @param {string} code Stable lower-kebab code the panel shows.
   * @param {string} message Human explanation.
   * @param {{ kind: string, params?: Record<string, string> }} [importIssue] Localizable import failure.
   */
  constructor(code, message, importIssue) {
    super(message)
    this.code = code
    this.importIssue = importIssue
    this.name = 'McpError'
  }
}

/** Strict JSON import; deliberately bypasses the panel's coercion and !!js handling. */
function parseImport(text) {
  if (typeof text !== 'string') throw new McpError('invalid', 'import text must be a JSON string')
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new McpError('invalid', 'import JSON must be 1 MiB or smaller')
  let input
  try {
    input = JSON.parse(text)
  } catch {
    throw new McpError('invalid', 'import text is not JSON', { kind: 'invalid-json' })
  }
  // JSON.parse keeps only the last duplicate; inspect keys before accepting that loss.
  if (parseDocument(text).errors.some((error) => error.code === 'DUPLICATE_KEY')) {
    throw new McpError('invalid', 'import JSON contains duplicate keys', { kind: 'duplicate-key' })
  }
  const plain = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  const invalid = (message, importIssue) => { throw new McpError('invalid', message, importIssue) }
  if (!plain(input)) invalid('import must be an object')
  if (Object.hasOwn(input, 'mcpServers')) {
    if (Object.keys(input).length !== 1) invalid('only mcpServers is supported at the import root')
    input = input.mcpServers
  }
  if (!plain(input) || Object.keys(input).length === 0) invalid('mcpServers must be a nonempty object')
  return Object.entries(input).map(([serverName, server]) => {
    if (!SERVER_NAME.test(serverName)) invalid(`invalid server name "${serverName}"; use 1-32 characters of A-Z a-z 0-9 _ -`)
    if (!plain(server)) invalid(`server "${serverName}" must be an object`)
    const type = Object.hasOwn(server, 'type') ? server.type : (Object.hasOwn(server, 'url') ? 'http' : 'stdio')
    if (!['stdio', 'http', 'streamable-http'].includes(type)) {
      invalid(`unsupported transport for "${serverName}"`, { kind: 'unsupported-transport', params: { serverName } })
    }
    const stdio = type === 'stdio'
    const allowed = stdio ? ['type', 'command', 'args', 'env', 'cwd'] : ['type', 'url', 'headers']
    for (const key of Object.keys(server)) {
      if (!allowed.includes(key)) {
        invalid(`unsupported field "${key}" for "${serverName}"`, {
          kind: 'unsupported-field', params: { serverName, field: key, allowed: allowed.join(', ') },
        })
      }
    }
    const required = stdio ? 'command' : 'url'
    if (typeof server[required] !== 'string' || server[required].trim() === '') invalid(`"${serverName}" needs a nonempty ${required} string`)
    if (Object.hasOwn(server, 'cwd') && typeof server.cwd !== 'string') invalid(`cwd for "${serverName}" must be a string`)
    if (Object.hasOwn(server, 'args') && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))) invalid(`args for "${serverName}" must be an array of strings`)
    const dictionary = stdio ? 'env' : 'headers'
    if (Object.hasOwn(server, dictionary) && (!plain(server[dictionary]) || Object.values(server[dictionary]).some((value) => typeof value !== 'string'))) invalid(`${dictionary} for "${serverName}" must be an object of strings`)
    if (Object.hasOwn(server[dictionary] ?? {}, '__jsExpr')) invalid(`reserved key "__jsExpr" in ${dictionary} for "${serverName}"`)
    const { type: _type, ...fields } = server
    return { serverName, transport: stdio ? 'stdio' : 'streamable-http', ...(stdio ? { args: [] } : {}), ...fields }
  })
}

/** Cordis fiber states, mirroring the Loader's numeric codes. */
const FIBER_PHASE = ['pending', 'loading', 'active', 'failed', null, 'unloading']

/** Read one entry's lifecycle phase the way the plugin inventory reports it. */
function phaseOf(entry) {
  const state = entry.fiber?.state
  if (state === undefined) return 'pending'
  return FIBER_PHASE[state] ?? 'pending'
}

/** The MCP manager's operations, independent of any transport. */
class McpManager {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx Owning plugin context.
   * @param {{ manage?: boolean }} [config] Resolved plugin config.
   * @param {{ insertMany: (rows: object[]) => Promise<void>, remove: (row: object) => Promise<void> }} [patches] Profile patch writer.
   */
  constructor(ctx, config = {}, patches) {
    this.ctx = ctx
    this.manage = config.manage !== false
    this.patchWriter = patches
  }

  /** Every configured MCP server row, with the tool names the model sees. */
  async list() {
    const entries = [...this.ctx.loader.entries()].filter((entry) =>
      entry.options.name === MCP_CLIENT && typeof entry.options.config?.serverName === 'string' &&
      entry.options.config.serverName !== '')
    const counts = new Map()
    for (const entry of this.ctx.loader.entries()) {
      const id = entry.options.id
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const editable = this.manage ? new Set(this.ctx.configEditor?.entries?.() ?? []) : new Set()
    const removable = this.manage ? await this.patchWriter?.removableRows?.(entries.map((entry) => entry.options)) : undefined
    const servers = entries.map((entry) => ({
      ...this.view(entry, entry.options.config),
      editable: editable.has(entry) && phaseOf(entry) === 'active',
      removable: counts.get(entry.options.id) === 1 && removable?.has(entry.options.id) === true,
    }))
    servers.sort((left, right) => left.serverName.localeCompare(right.serverName))
    return { manage: this.manage, servers }
  }

  /**
   * Create or update one server row.
   * @param {object} server Panel payload.
   * @returns {Promise<{ rowId: string, created: boolean }>}
   */
  async save(server) {
    this.requireManage()
    const draft = this.validate(server, undefined)
    const existing = this.rowNamed(draft.serverName, draft.rowId)
    if (draft.rowId === undefined && existing !== undefined) {
      throw new McpError('invalid', `MCP server "${draft.serverName}" already exists`)
    }
    if (draft.rowId !== undefined && existing?.rowId !== draft.rowId) {
      throw new McpError('not-found', `MCP server "${draft.serverName}" changed or no longer exists; reopen the panel`)
    }
    const previous = existing === undefined ? {} : existing.entry.options.config ?? {}
    if (existing !== undefined) {
      const next = (current) => {
        if (draft.revision !== undefined && revisionOf(current) !== draft.revision) {
          throw new McpError('not-found', 'MCP server configuration changed; reopen the panel')
        }
        return this.configFor(this.validate(draft, current), current)
      }
      const config = next(previous)
      if (isDeepStrictEqual(previous, config)) {
        return { rowId: existing.rowId, created: false }
      }
      await this.ctx.configEditor.edit(existing.entry, (current) => {
        this.patchWriter?.assertSafeConfigEdit?.()
        return next(current)
      })
      return { rowId: existing.rowId, created: false }
    }

    const config = this.configFor(this.validate(draft, {}), {})
    const rowId = this.freeRowId(`mcp-${draft.serverName}`)
    await this.patches().insertMany([{ id: rowId, name: MCP_CLIENT, config }])
    return { rowId, created: true }
  }

  /** Validate an import without writing or evaluating any imported strings. */
  previewImport(text) {
    this.requireManage()
    const servers = parseImport(text)
    for (const server of servers) {
      const { serverName } = server
      if (this.rowNamed(serverName) !== undefined) {
        throw new McpError('invalid', `MCP server "${serverName}" already exists`, {
          kind: 'duplicate-server', params: { serverName },
        })
      }
    }
    return { servers }
  }

  /** Revalidate the whole batch and commit it in one profile transaction. */
  async importServers(text) {
    const { servers } = this.previewImport(text)
    const taken = new Set([...this.ctx.loader.entries()].map((entry) => entry.options.id))
    const rows = servers.map((config) => {
      const id = this.freeRowId(`mcp-${config.serverName}`, taken)
      taken.add(id)
      return { id, name: MCP_CLIENT, config }
    })
    try {
      await this.patches().insertMany(rows)
    } catch (error) {
      if (error.code === 'invalid') throw new McpError('invalid', error.message, error.importIssue)
      throw error
    }
    return { imported: rows.length }
  }

  /**
   * Drop one server row.
   * @param {string} serverName Server namespace to remove.
   * @param {string} [rowId] Row the panel originally displayed.
   * @returns {Promise<{ removed: string }>}
   */
  async remove(serverName, rowId, revision) {
    this.requireManage()
    const name = String(serverName ?? '')
    const existing = this.rowNamed(name, rowId)
    if (existing === undefined || (rowId !== undefined && existing.rowId !== rowId)) {
      throw new McpError('not-found', `MCP server "${name}" changed or no longer exists; reopen the panel`)
    }
    // `name` lets the writer drop the matching top-level override too: editing an
    // inserted row appends one, and leaving it behind would resurrect the old
    // config when the same server name is added again.
    const config = existing.entry.options.config
    if (revision !== undefined && revisionOf(config) !== revision) {
      throw new McpError('not-found', 'MCP server configuration changed; reopen the panel')
    }
    await this.patches().remove({ id: existing.rowId, name: MCP_CLIENT, config })
    return { removed: existing.rowId }
  }

  /** Panel-visible projection of one row. */
  view(entry, config) {
    const serverName = config.serverName
    return {
      rowId: entry.options.id,
      revision: revisionOf(config),
      serverName,
      transport: config.transport === 'stdio' ? 'stdio' : 'streamable-http',
      command: renderValue(config.command),
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: viewDict(config.env),
      cwd: renderValue(config.cwd),
      url: renderValue(config.url),
      headers: viewDict(config.headers),
      failOnStartupError: config.failOnStartupError === true,
      enabled: entry.disabled !== true,
      phase: phaseOf(entry),
      tools: this.toolNames(serverName),
    }
  }

  /** Tool names the model currently sees for one server namespace. */
  toolNames(serverName) {
    const tools = this.ctx.get('tools')
    if (tools === undefined) return []
    try {
      return tools
        .schemas()
        .map((schema) => schema.name)
        .filter((name) => typeof name === 'string' && name.startsWith(`mcp__${serverName}__`))
    } catch {
      return []
    }
  }

  /** Normalize the panel payload and reject what the Config schema would reject later. */
  validate(input, current) {
    const serverName = String(input?.serverName ?? '').trim()
    if (!SERVER_NAME.test(serverName)) {
      throw new McpError('invalid', 'server name must be 1-32 characters of A-Z a-z 0-9 _ -')
    }
    const transport = input?.transport
    if (transport !== 'stdio' && transport !== 'streamable-http') throw new McpError('invalid', 'unsupported MCP transport')
    if (current === undefined) return { ...input, serverName, transport }
    const previous = current.transport === transport ? current : {}
    if (transport === 'stdio') {
      if (String(input?.command ?? renderValue(previous.command)).trim() === '') throw new McpError('invalid', 'stdio transport needs a command')
    } else if (String(input?.url ?? renderValue(previous.url)).trim() === '') {
      throw new McpError('invalid', 'streamable-http transport needs a URL')
    }
    return { ...input, serverName, transport }
  }

  /** Panel payload plus preserved fields -> raw `mcp-client` config. */
  configFor(server, previous) {
    const config = { ...previous }
    if (previous.transport !== server.transport) {
      for (const key of TRANSPORT_FIELDS) delete config[key]
    }
    // The checkbox is authoritative when the panel sends it: a new row has no
    // `previous`, so copying it only from there silently dropped the field.
    if (typeof server.failOnStartupError === 'boolean') config.failOnStartupError = server.failOnStartupError
    config.serverName = server.serverName
    config.transport = server.transport
    if (server.transport === 'stdio') {
      if (server.command !== undefined && server.command !== renderValue(config.command)) config.command = String(server.command).trim()
      if (server.args !== undefined || server.argsText !== undefined) {
        const args = typeof server.argsText === 'string'
          ? server.argsText.split('\n').map((line) => line.trim())
          : server.args
        config.args = Array.isArray(previous.args) && previous.args.join('\n') === server.argsText
          ? previous.args
          : cleanList(args)
      }
      if (server.cwd !== undefined && server.cwd !== renderValue(config.cwd)) {
        const cwd = String(server.cwd).trim()
        if (cwd === '') delete config.cwd
        else config.cwd = cwd
      }
      if (server.env !== undefined) config.env = cleanDict(server.env, previous.env)
    } else {
      if (server.url !== undefined && server.url !== renderValue(config.url)) config.url = String(server.url).trim()
      if (server.headers !== undefined) config.headers = cleanDict(server.headers, previous.headers)
    }
    return config
  }

  /** The row whose `serverName` matches, with its Loader entry. */
  rowNamed(serverName, rowId) {
    let match
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.name !== MCP_CLIENT) continue
      if (entry.options.config?.serverName !== serverName) continue
      if (rowId === undefined) return { rowId: entry.options.id, entry }
      if (entry.options.id !== rowId) continue
      if (match !== undefined) return undefined
      match = { rowId, entry }
    }
    return match
  }

  /** A row id no other Loader entry uses. */
  freeRowId(base, taken = new Set([...this.ctx.loader.entries()].map((entry) => entry.options.id))) {
    if (!taken.has(base)) return base
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base}-${index}`
      if (!taken.has(candidate)) return candidate
    }
    throw new McpError('invalid', `no free row id for "${base}"`)
  }

  /** Refuse writes when the profile owner turned management off. */
  requireManage() {
    if (this.manage) return
    throw new McpError('read-only', "MCP management is disabled by this plugin's `manage: false`")
  }

  /** The profile patch writer for row insert and remove. */
  patches() {
    if (this.patchWriter === undefined) throw new McpError('unavailable', 'this composition has no editable profile patch')
    return this.patchWriter
  }
}

/** Answer one panel operation. */
async function handle(manager, payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  switch (body.action) {
    case 'list':
      return manager.list()
    case 'previewImport':
      return manager.previewImport(body.text)
    case 'import':
      return manager.importServers(body.text)
    case 'save':
      return manager.save(body.server)
    case 'remove':
      return manager.remove(body.serverName, body.rowId, body.revision)
    default:
      throw new McpError('invalid', `unknown action ${JSON.stringify(body.action)}`)
  }
}

/** Read a JSON request body. */
async function readJson(request) {
  const text = await request.text()
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new McpError('invalid', 'request body is not JSON')
  }
}

/** Build one JSON response. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Services this Host half needs, declared at module level.
 *
 * The Loader reads this export before calling `apply`, which is how the shipped
 * `session-log-export` obtains `connection` and `commands`. Nested `ctx.inject`
 * is not equivalent: `connection.fetch.register` and `rpc.handle` both consult
 * the service's own Context, so a body that only *reaches* Connection through a
 * child inject fails with `cannot get property "webServer" without inject`.
 */
const inject = ['configEditor', 'connection', 'profileContext']

/**
 * Register the profile patch writer and the panel's Fetch route.
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @param {{ manage?: boolean }} [config] Resolved plugin config.
 */
export function apply(ctx, config = {}) {
  let manager

  ctx.effect(() => {
    const writer = createProfilePatchWriter(ctx)
    manager = new McpManager(ctx, config, writer)
    return () => { manager = undefined }
  }, 'mcp-manager: profile patch writer')

  // The browser half posts `{ action, ... }` here and reads `{ value }` or
  // `{ error }` back; the route rides the authenticated /api bridge.
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (manager === undefined) throw new McpError('unavailable', 'the profile patch writer is not mounted')
        return json({ value: await handle(manager, await readJson(request)) })
      } catch (error) {
        const code = error instanceof McpError ? error.code : 'operation-error'
        const message = error instanceof Error ? error.message : String(error)
        const importIssue = error instanceof McpError ? error.importIssue : undefined
        return json({ error: { code, message, importIssue } }, 400)
      }
    },
  }), 'mcp-manager: /api/mcp.manager route')
}

export { McpManager, McpError, MCP_CLIENT, ROUTE, inject }
