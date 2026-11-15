/**
 * Pure profile-patch document edits for the MCP manager.
 *
 * These helpers own nothing but the YAML text: they parse a profile patch,
 * insert or drop one plugin row, and serialize it back with comments and `!!js`
 * scalars intact. Keeping them free of Context lets the same code be tested
 * against a real patch file without a running profile.
 *
 * @module dsh-mcp-servers/patch-doc
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
 * The `insert` sequence of a patch document, or undefined when it has none.
 * @param {import('yaml').Document} document Parsed patch.
 */
function insertSequence(document) {
  let target
  for (const item of document.contents.items) {
    if (!isMap(item)) continue
    const insert = item.get('insert', true)
    if (isSeq(insert)) target = insert
  }
  return target
}

/**
 * Append one plugin row, creating the `insert` list when the patch has none.
 * @param {import('yaml').Document} document Parsed patch.
 * @param {{ id: string }} row Row to append.
 */
function insertRow(document, row) {
  let list = insertSequence(document)
  if (list === undefined) {
    document.contents.items.push(document.createNode({ insert: [] }))
    list = insertSequence(document)
  }
  const exists = list.items.some((item) => isMap(item) && item.get('id') === row.id)
  if (exists) throw new Error(`mcp-manager: row "${row.id}" already exists in the profile patch`)
  list.items.push(document.createNode(row))
  list.flow = false
  return document
}

/**
 * Drop one plugin row from the `insert` list.
 * @param {import('yaml').Document} document Parsed patch.
 * @param {{ id: string }} row Row to drop.
 */
function removeRow(document, row) {
  const list = insertSequence(document)
  const index = list === undefined ? -1 : list.items.findIndex((item) => isMap(item) && item.get('id') === row.id)
  if (index < 0) {
    throw new Error(`mcp-manager: row "${row.id}" is not an inserted profile row and cannot be removed here`)
  }
  list.items.splice(index, 1)
  if (list.items.length === 0) {
    const holder = document.contents.items.findIndex((item) => isMap(item) && isSeq(item.get('insert', true)) && item.get('insert', true).items.length === 0)
    if (holder >= 0) document.contents.items.splice(holder, 1)
  }
  return document
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

/**
 * Parse serialized text the way the profile loader reads it.
 * @param {string} text YAML text.
 */
function patchesOf(text) {
  return parsePatch(text).toJS()
}

export { parsePatch, insertSequence, insertRow, removeRow, serializePatch, patchesOf, JS_TAG }
