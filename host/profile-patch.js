/**
 * Profile-patch writer for the MCP manager.
 *
 * `ctx.configEditor` can rewrite the `config` of an existing row, but it cannot
 * add or delete a row. MCP servers are added and removed, so this file owns the
 * two operations `configEditor` lacks: it reads the profile patch, applies the
 * document edit from `./patch-doc.js` under the same HMR lock and file lock the
 * other profile writers use, writes the result atomically, then lets
 * `reconcileProfilePatches` recompose the Loader. A failed reconcile restores
 * the previous bytes.
 *
 * @module dsh-mcp-servers
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, visit } from 'yaml'
import { insertRow, parsePatch, removeRow, serializePatch } from './patch-doc.js'

/** Bin name the profile helpers expect. */
const BIN = 'dsh'

/** Package that owns the Loader reconcile path this writer must share. */
const APP_BOOT = '@deepseek-ai/dsh-app-boot'

/** Resolved `dsh-app-boot` instance, shared by every write in this process. */
let hostAppBoot

/**
 * Import the `dsh-app-boot` copy the running host itself imported.
 *
 * `reconcileProfilePatches` finds the root Include through a module-level
 * WeakMap keyed by the booted `ctx`. That map is per module instance, so a
 * second copy of the package (the one npm would install under this plugin)
 * has an empty map and throws `profile reload requires the root Include entry`
 * on every write. Resolving the package from the host's own installation
 * anchor — the same anchor the Loader uses for bare plugin names — yields the
 * exact module the host booted with, so the map is the host's.
 *
 * @param {string | undefined} installAnchor Absolute path of the dsh app's `package.json`.
 * @returns {Promise<typeof import('@deepseek-ai/dsh-app-boot')>} The host's module.
 */
async function appBoot(installAnchor) {
  if (hostAppBoot !== undefined) return hostAppBoot
  let specifier
  if (typeof installAnchor === 'string' && installAnchor !== '') {
    // `resolve` walks the anchor's node_modules chain, which is the same lookup
    // the Loader performs for the host's own imports; a file URL then makes the
    // ESM cache hand back the instance the host already evaluated.
    try {
      specifier = pathToFileURL(createRequire(installAnchor).resolve(APP_BOOT)).href
    } catch {
      specifier = undefined
    }
  }
  // Bare fallback for a host that exposes no anchor (tests, embedders). It can
  // only ever find a second copy, so the reconcile call still fails loud.
  hostAppBoot = await import(specifier ?? APP_BOOT)
  return hostAppBoot
}

/**
 * Build the patch writer.
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context that owns the profile.
 * @returns {{ insert: (row: object) => Promise<void>, insertMany: (rows: object[]) => Promise<void>, remove: (row: object) => Promise<void> }}
 */
function createProfilePatchWriter(ctx) {
  const profile = ctx.profileContext
  if (profile === undefined) throw new Error('mcp-manager: this composition has no profile context')

  /** Read the profile patch text, or an empty entry list. */
  async function readText() {
    try {
      return await readFile(profile.patchPath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return '[]\n'
    }
  }

  /** Persist the document and wait for the Loader to settle, restoring on failure. */
  async function persist(before, document, requiredIds) {
    const text = serializePatch(document)
    const { readProfilePatches, reconcileProfilePatches } = await appBoot(profile.installAnchor)
    await writeFileAtomic(profile.patchPath, text, { mode: 0o600 })
    try {
      // Read the patch back through dsh's own loader dialect instead of
      // re-parsing `text` here: `entryListSchema` turns `!!js` into
      // `{ __jsExpr }`, while a plain `toJS()` would hand the Loader a literal
      // string and silently flip every expression row for the rest of the
      // session. Everything after the write stays inside the rollback guard.
      const patches = readProfilePatches(BIN, profile)
      await reconcileProfilePatches(ctx.root, patches, BIN, requiredIds)
    } catch (error) {
      await writeFileAtomic(profile.patchPath, before, { mode: 0o600 })
      try {
        await reconcileProfilePatches(ctx.root, readProfilePatches(BIN, profile), BIN)
      } catch {
        // The composition may already be unusable; the file is restored either way.
      }
      throw error
    }
  }

  /** Run one edit under the profile lock and the HMR queue. */
  async function exclusive(operation) {
    const run = async () => {
      await withFileLock(join(profile.dir, 'package.json'), async () => {
        const before = await readText()
        const document = parsePatch(before)
        const requiredIds = operation(document)
        await persist(before, document, requiredIds)
      })
    }
    const hmr = ctx.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }

  return {
    /** Append one plugin row to the profile patch. */
    insert(row) {
      return exclusive((document) => {
        insertRow(document, row)
        return [row.id]
      })
    },
    /** Append a whole batch, checking names again after entering the lock. */
    insertMany(rows) {
      return exclusive((document) => {
        const names = new Set()
        for (const entry of ctx.loader.entries()) {
          if (entry.options.name === rows[0]?.name) names.add(entry.options.config?.serverName)
        }
        // Include rows written by another process that this Loader has not seen yet.
        visit(document, {
          Map(_key, node) {
            if (node.get('name') !== rows[0]?.name) return
            const config = node.get('config', true)
            if (isMap(config)) names.add(config.get('serverName'))
          },
        })
        for (const row of rows) {
          const name = row.config.serverName
          if (names.has(name)) throw Object.assign(new Error(`MCP server "${name}" already exists`), { code: 'invalid' })
          names.add(name)
        }
        for (const row of rows) insertRow(document, row)
        return rows.map((row) => row.id)
      })
    },
    /** Remove one plugin row from the profile patch. */
    remove(row) {
      return exclusive((document) => {
        removeRow(document, row)
        return []
      })
    },
  }
}

export { createProfilePatchWriter }
