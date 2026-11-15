/**
 * Pure profile-patch document edits for the MCP manager.
 *
 * These helpers own nothing but the YAML text: they parse a profile patch,
 * insert or drop one plugin row, and serialize it back with comments and `!!js`
 * scalars intact. Keeping them free of Context lets the same code be tested
 * against a real patch file without a running profile.
 *
 * @module dsh-mcp-command/patch-doc
 */
import { isMap, isSeq, parseDocument, Scalar, visit } from 'yaml'

/** The `tag:yaml.org,2002:js` custom tag `!!js` scalars are parsed with. */
const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value) => value,
}

/**
 * Parse a profile patch.
 * @param {string} text File contents; an empty string reads as an empty list.
 * @returns {import('yaml').Document} Document that keeps comments and tags.
 */
function parsePatch(text) {
  const source = text.trim() === '' ? '[]\n' : text
  const document = parseDocument(source, { customTags: [JS_TAG] })
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (document.contents === null) document.contents = document.createNode([])
  if (!isSeq(document.contents)) throw new Error('mcp-manager: the profile patch must be a YAML sequence')
  document.contents.flow = false
  return document
}

/**
 * Every `insert` sequence of a patch document, in file order.
 *
 * A patch file may hold more than one `{ insert: [...] }` block — the loader
 * composes them all, and nothing forbids it. Callers must therefore search
 * every block, not just the last one: a row living in an earlier block is just
 * as real to the Loader, and reporting it as "not inserted" would make a
 * server the panel lists impossible to delete.
 *
 * @param {import('yaml').Document} document Parsed patch.
 * @returns {import('yaml').YAMLSeq[]} The insert sequences, possibly empty.
 */
function insertSequences(document) {
  const lists = []
  for (const item of document.contents.items) {
    if (!isMap(item)) continue
    const insert = item.get('insert', true)
    if (isSeq(insert)) lists.push(insert)
  }
  return lists
}

/**
 * The `insert` sequence new rows are appended to, or undefined when the patch
 * has none. Appending stays in the last block so a save never reorders the
 * user's file structure.
 * @param {import('yaml').Document} document Parsed patch.
 */
function insertSequence(document) {
  const lists = insertSequences(document)
  return lists[lists.length - 1]
}

/**
 * Append one plugin row, creating the `insert` list when the patch has none.
 * @param {import('yaml').Document} document Parsed patch.
 * @param {{ id: string }} row Row to append.
 */
function insertRow(document, row) {
  // Uniqueness is checked across every block: two rows with the same id in
  // different insert lists would both mount, and the Loader could not tell
  // which one a later override targets.
  const duplicated = insertSequences(document).some((list) => list.items.some((item) => isMap(item) && item.get('id') === row.id))
  if (duplicated) throw new Error(`mcp-manager: row "${row.id}" already exists in the profile patch`)
  let list = insertSequence(document)
  if (list === undefined) {
    document.contents.items.push(document.createNode({ insert: [] }))
    list = insertSequence(document)
  }
  list.items.push(document.createNode(row))
  list.flow = false
  return document
}

/**
 * Drop one plugin row from the `insert` list, together with every top-level
 * override that targets the same row.
 *
 * `ctx.configEditor.edit()` cannot see an inserted row (it only looks at
 * top-level items), so editing one appends a top-level `{id, name, config}`
 * override to the end of the file. That override outlives the inserted row and
 * would shadow a later insert of the same server name, so removal has to drop
 * both halves or a re-added server silently keeps the old config.
 *
 * @param {import('yaml').Document} document Parsed patch.
 * @param {{ id: string, name?: string }} row Row to drop.
 */
function removeRow(document, row) {
  // Search every insert block: the target may live in an earlier block than the
  // one new rows are appended to, and it is just as real to the Loader there.
  let list
  for (const candidate of insertSequences(document)) {
    if (!candidate.items.some((item) => isMap(item) && item.get('id') === row.id)) continue
    list = candidate
    break
  }
  if (list === undefined) {
    throw new Error(`mcp-manager: row "${row.id}" is not an inserted profile row and cannot be removed here`)
  }
  list.items.splice(list.items.findIndex((item) => isMap(item) && item.get('id') === row.id), 1)
  if (list.items.length === 0) {
    // Drop the holder this row came from, and only that one: an unrelated
    // insert block (even an empty one) belongs to the user, not to this edit.
    const holder = document.contents.items.findIndex((item) => isMap(item) && item.get('insert', true) === list)
    if (holder >= 0) document.contents.items.splice(holder, 1)
  }
  for (let at = document.contents.items.length - 1; at >= 0; at -= 1) {
    if (isOverrideOf(document.contents.items[at], row)) document.contents.items.splice(at, 1)
  }
  return document
}

/**
 * Whether one top-level patch item overrides the given row.
 * @param {unknown} item One top-level patch item.
 * @param {{ id: string, name?: string }} row Row to match.
 * @returns {boolean} True for a top-level override of that row.
 */
function isOverrideOf(item, row) {
  if (!isMap(item) || item.has('insert')) return false
  if (item.get('id') !== row.id) return false
  if (row.name === undefined || !item.has('name')) return true
  return item.get('name') === row.name
}

/**
 * Serialize a patch document, writing `{ __jsExpr }` markers back as `!!js`
 * scalars so the Loader evaluates them at activation.
 * @param {import('yaml').Document} document Parsed patch.
 * @returns {string} YAML text.
 */
function serializePatch(document) {
  visit(document, {
    Map(_key, node) {
      const key = node.items[0]?.key?.value
      if (node.items.length !== 1 || key !== '__jsExpr') return
      const expression = new Scalar(node.items[0].value?.value)
      expression.tag = 'tag:yaml.org,2002:js'
      return expression
    },
  })
  return String(document)
}

export { parsePatch, insertSequence, insertSequences, insertRow, removeRow, serializePatch, JS_TAG }
