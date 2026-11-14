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
 * @module dsh-mcp-command
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { loadProfileDirectory, readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { insertRow, parsePatch, patchesOf, removeRow, serializePatch } from './patch-doc.js'

/** Bin name the profile helpers expect. */
const BIN = 'dsh'

/**
 * Build the patch writer.
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context that owns the profile.
 * @returns {{ insert: (row: object) => Promise<void>, remove: (row: object) => Promise<void> }}
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
    await writeFileAtomic(profile.patchPath, text, { mode: 0o600 })
    try {
      // Everything after the write stays inside the rollback guard: a failure
      // while reading the just-written patches would otherwise leave the file
      // changed while the Loader still runs the previous composition.
      const patches = readProfilePatches(BIN, profile, {
        ...loadProfileDirectory(BIN, profile.dir, profile.installAnchor),
        patches: patchesOf(text),
      })
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
