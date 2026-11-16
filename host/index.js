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
import { isDeepStrictEqual } from 'node:util'
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

/** Row fields carried over unchanged when the panel rewrites an existing row. */
const PRESERVED = ['toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError', 'reconnect']

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
function cleanDict(input) {
  const out = {}
  if (input !== null && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      const name = String(key).trim()
      // A caller that posts the marker object directly keeps it; the panel posts
      // the `!!js <expr>` text form, which `restoreValue` turns back into one.
      const kept = isJsExpr(value) ? value : restoreValue(String(value ?? '').trim())
      const blank = typeof kept === 'string' ? kept === '' : kept.__jsExpr === ''
      if (name !== '' && !blank) out[name] = kept
    }
  }
  return out
}

/** Panel-visible copy of one dictionary, with `!!js` expressions rendered as text. */
function viewDict(input) {
  const out = {}
  if (input !== null && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) out[key] = renderValue(value)
  }
  return out
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
   */
  constructor(code, message) {
    super(message)
    this.code = code
    this.name = 'McpError'
  }
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
   * @param {{ insert: (row: object) => Promise<void>, remove: (row: object) => Promise<void> }} [patches] Profile patch writer.
   */
  constructor(ctx, config = {}, patches) {
    this.ctx = ctx
    this.manage = config.manage !== false
    this.patchWriter = patches
  }

  /** Every configured MCP server row, with the tool names the model sees. */
  list() {
    const servers = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.name !== MCP_CLIENT) continue
      const config = entry.options.config ?? {}
      if (typeof config.serverName !== 'string' || config.serverName === '') continue
      servers.push(this.view(entry, config))
    }
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
    const draft = this.validate(server)
    const existing = this.rowNamed(draft.serverName)
    const previous = existing === undefined ? {} : existing.entry.options.config ?? {}
    const config = this.configFor(draft, previous)

    if (existing !== undefined) {
      if (isDeepStrictEqual(previous, config)) {
        return { rowId: existing.rowId, created: false }
      }
      await this.ctx.configEditor.edit(existing.entry, () => ({ ...config }))
      return { rowId: existing.rowId, created: false }
    }

    const rowId = this.freeRowId(`mcp-${draft.serverName}`)
    await this.patches().insert({ id: rowId, name: MCP_CLIENT, config })
    return { rowId, created: true }
  }

  /**
   * Drop one server row.
   * @param {string} serverName Server namespace to remove.
   * @returns {Promise<{ removed: string }>}
   */
  async remove(serverName) {
    this.requireManage()
    const name = String(serverName ?? '')
    const existing = this.rowNamed(name)
    if (existing === undefined) throw new McpError('not-found', `no MCP server named "${name}"`)
    // `name` lets the writer drop the matching top-level override too: editing an
    // inserted row appends one, and leaving it behind would resurrect the old
    // config when the same server name is added again.
    await this.patches().remove({ id: existing.rowId, name: MCP_CLIENT })
    return { removed: existing.rowId }
  }

  /** Panel-visible projection of one row. */
  view(entry, config) {
    const serverName = config.serverName
    return {
      rowId: entry.options.id,
      serverName,
      transport: config.transport === 'stdio' ? 'stdio' : 'streamable-http',
      command: typeof config.command === 'string' ? config.command : '',
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: viewDict(config.env),
      cwd: typeof config.cwd === 'string' ? config.cwd : '',
      url: typeof config.url === 'string' ? config.url : '',
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
  validate(input) {
    const serverName = String(input?.serverName ?? '').trim()
    if (!SERVER_NAME.test(serverName)) {
      throw new McpError('invalid', 'server name must be 1-32 characters of A-Z a-z 0-9 _ -')
    }
    const transport = input?.transport === 'stdio' ? 'stdio' : 'streamable-http'
    if (transport === 'stdio') {
      if (String(input?.command ?? '').trim() === '') throw new McpError('invalid', 'stdio transport needs a command')
    } else if (String(input?.url ?? '').trim() === '') {
      throw new McpError('invalid', 'streamable-http transport needs a URL')
    }
    return { ...input, serverName, transport }
  }

  /** Panel payload plus preserved fields -> raw `mcp-client` config. */
  configFor(server, previous) {
    const config = {}
    for (const key of PRESERVED) {
      if (previous[key] !== undefined) config[key] = previous[key]
    }
    // The checkbox is authoritative when the panel sends it: a new row has no
    // `previous`, so copying it only from there silently dropped the field.
    if (typeof server.failOnStartupError === 'boolean') config.failOnStartupError = server.failOnStartupError
    config.serverName = server.serverName
    config.transport = server.transport
    if (server.transport === 'stdio') {
      config.command = String(server.command).trim()
      config.args = cleanList(server.args)
      const cwd = String(server.cwd ?? '').trim()
      if (cwd !== '') config.cwd = cwd
      const env = cleanDict(server.env)
      if (Object.keys(env).length > 0) config.env = env
    } else {
      config.url = String(server.url).trim()
      const headers = cleanDict(server.headers)
      if (Object.keys(headers).length > 0) config.headers = headers
    }
    return config
  }

  /** The row whose `serverName` matches, with its Loader entry. */
  rowNamed(serverName) {
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.name !== MCP_CLIENT) continue
      if (entry.options.config?.serverName !== serverName) continue
      return { rowId: entry.options.id, entry }
    }
    return undefined
  }

  /** A row id no other Loader entry uses. */
  freeRowId(base) {
    const taken = new Set([...this.ctx.loader.entries()].map((entry) => entry.options.id))
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
    case 'save':
      return manager.save(body.server)
    case 'remove':
      return manager.remove(body.serverName)
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
        return json({ error: { code, message } }, 400)
      }
    },
  }), 'mcp-manager: /api/mcp.manager route')
}

export { McpManager, McpError, MCP_CLIENT, ROUTE, inject }
