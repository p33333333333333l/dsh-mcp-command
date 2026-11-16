/**
 * `/mcp` panel for the DSH Web UI.
 *
 * A client command registers `/mcp`; picking or entering it opens a floating
 * panel (the Session's composer overlay) that lists the profile's MCP servers,
 * their exposed tools and their transport, and lets the user add, edit and
 * remove a server. Every mutation goes to the Host `mcpManager` service, which
 * writes the profile patch and lets the Loader reload the MCP client in place.
 *
 * @module dsh-mcp-servers/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-servers',
  factory(require) {
    const React = require('react')
    // `createPortal` lets the panel mount on `document.body`. Without it the
    // panel renders inside the conversation column, whose `overflow:hidden` and
    // stacking context clip it and let the sidebar paint over it.
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    /** Dictionary namespace owned by this plugin. */
    const NS = 'mcpManager'

    const zh = {
      'command.mcp.label': 'MCP 服务器',
      'command.mcp.description': '查看和管理 MCP 服务器',
      'panel.aria': 'MCP 服务器',
      'panel.title': 'MCP 服务器',
      'panel.refresh': '刷新',
      'panel.close': '关闭',
      'panel.add': '添加服务器',
      'import.title': '导入',
      'import.source': 'JSON 配置',
      'import.file': '选择 JSON 文件',
      'import.hint': '粘贴 mcpServers 配置，或选择 JSON 文件。重名服务器不会被覆盖。',
      'import.preview': '预览',
      'import.confirm': '确认导入',
      'import.busy': '处理中…',
      'import.ready': '待导入服务器：',
      'import.done': '已导入服务器：',
      'import.tooLarge': '配置不能超过 1 MiB。',
      'import.readFailed': '无法读取文件。',
      'panel.empty': '还没有配置 MCP 服务器。',
      'panel.loading': '正在读取配置…',
      'panel.failed': '读取失败',
      'panel.retry': '重试',
      'panel.readOnly': '当前插件以只读模式运行（manage: false），不能在这里修改配置。',
      'row.tools': '工具',
      'row.phase.active': '运行中',
      'row.phase.failed': '加载失败',
      'row.phase.pending': '等待中',
      'row.phase.other': '未运行',
      'row.disabled': '已禁用',
      'row.edit': '编辑',
      'row.remove': '删除',
      'row.confirmRemove': '删除后该服务器的工具会一并移除，确定吗？',
      'row.yes': '删除',
      'row.no': '取消',
      'form.addTitle': '添加 MCP 服务器',
      'form.editTitle': '编辑 MCP 服务器',
      'form.name': '服务器名',
      'form.nameHint': '字母、数字、下划线或连字符，最多 32 个字符。',
      'form.transport': '连接方式',
      'form.stdio': '本地进程 (stdio)',
      'form.http': '远程 HTTP',
      'form.command': '命令',
      'form.args': '参数（每行一个）',
      'form.cwd': '工作目录（可选）',
      'form.env': '环境变量（每行 KEY=VALUE，值可写 !!js 表达式）',
      'form.url': '服务地址',
      'form.headers': '请求头（每行 NAME=VALUE，值可写 !!js 表达式）',
      'form.failOnStartup': '连接失败时阻止启动',
      'form.save': '保存',
      'form.cancel': '取消',
      'form.saving': '保存中…',
      'form.required': '请填写必填项。',
    }

    const en = {
      'command.mcp.label': 'MCP servers',
      'command.mcp.description': 'View and manage MCP servers',
      'panel.aria': 'MCP servers',
      'panel.title': 'MCP servers',
      'panel.refresh': 'Refresh',
      'panel.close': 'Close',
      'panel.add': 'Add server',
      'import.title': 'Import',
      'import.source': 'JSON configuration',
      'import.file': 'Choose JSON file',
      'import.hint': 'Paste mcpServers JSON or choose a file. Existing servers are never overwritten.',
      'import.preview': 'Preview',
      'import.confirm': 'Confirm import',
      'import.busy': 'Working…',
      'import.ready': 'Servers to import: ',
      'import.done': 'Servers imported: ',
      'import.tooLarge': 'Configuration must be 1 MiB or smaller.',
      'import.readFailed': 'Could not read the file.',
      'panel.empty': 'No MCP server is configured yet.',
      'panel.loading': 'Reading configuration…',
      'panel.failed': 'Could not read the configuration',
      'panel.retry': 'Retry',
      'panel.readOnly': 'This plugin runs read-only (manage: false), so the configuration cannot be changed here.',
      'row.tools': 'tools',
      'row.phase.active': 'Running',
      'row.phase.failed': 'Failed to load',
      'row.phase.pending': 'Pending',
      'row.phase.other': 'Not running',
      'row.disabled': 'Disabled',
      'row.edit': 'Edit',
      'row.remove': 'Remove',
      'row.confirmRemove': 'This removes the server and its tools. Continue?',
      'row.yes': 'Remove',
      'row.no': 'Cancel',
      'form.addTitle': 'Add an MCP server',
      'form.editTitle': 'Edit MCP server',
      'form.name': 'Server name',
      'form.nameHint': 'Letters, digits, underscores or hyphens; up to 32 characters.',
      'form.transport': 'Connection',
      'form.stdio': 'Local process (stdio)',
      'form.http': 'Remote HTTP',
      'form.command': 'Command',
      'form.args': 'Arguments (one per line)',
      'form.cwd': 'Working directory (optional)',
      'form.env': 'Environment (KEY=VALUE per line; a value may be a !!js expression)',
      'form.url': 'Server URL',
      'form.headers': 'Request headers (NAME=VALUE per line; a value may be a !!js expression)',
      'form.failOnStartup': 'Block startup when the connection fails',
      'form.save': 'Save',
      'form.cancel': 'Cancel',
      'form.saving': 'Saving…',
      'form.required': 'Fill in the required fields.',
    }

    /**
     * Menu glyph for the `/mcp` row: two stacked server blocks joined by a link.
     *
     * The slash-menu renders a contribution's `icon` either as a built-in
     * `ReferenceIconRegular` kind (a string) or as a component, calling
     * `h(item.icon, { size: 14 })`. This component keeps the plugin free of any
     * primitives import, which a profile-installed bundle cannot resolve.
     */
    function McpMenuIcon({ size = 14 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      },
        h('rect', { x: 1.6, y: 1.8, width: 5.4, height: 3.4, rx: 1 }),
        h('rect', { x: 1.6, y: 10.8, width: 5.4, height: 3.4, rx: 1 }),
        h('rect', { x: 9, y: 6.3, width: 5.4, height: 3.4, rx: 1 }),
        h('path', { d: 'M7 3.5h1.1a.9.9 0 0 1 .9.9v2.8' }),
        h('path', { d: 'M7 12.5h1.1a.9.9 0 0 0 .9-.9V8.8' }))
    }

    /**
     * Panel styles.
     *
     * Every color is a real `--dsw-alias-*` theme token, so the panel follows the
     * active light/dark theme instead of falling back to hardcoded light colors.
     * The names come from the Theme provider and from `dsh-client-ui-theme`, which
     * defines both variants; no fallback value is needed because the tokens are
     * always defined while the UI is mounted.
     */
    const CSS = `
/* Sits above every shipped layer (dialogs use 1000, small panels 1250);
   2000 keeps this modal on top even after a future panel raises its value. */
.mcp-backdrop{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-mask-1);padding:24px;box-sizing:border-box}
.mcp-panel{display:flex;flex-direction:column;width:min(1040px,100%);max-height:calc(100dvh - 48px);
  box-sizing:border-box;min-width:0;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l2);border-radius:14px;
  box-shadow:var(--dsw-elevation-prominent);overflow:hidden;
  font-size:13px;line-height:1.5}
.mcp-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.mcp-head h2{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.mcp-sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mcp-head-actions{margin-left:auto;display:flex;gap:6px}
.mcp-body{overflow:auto;padding:12px 18px 18px;flex:1;min-height:0}
.mcp-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);
  border-radius:8px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer;
  position:relative;transition:border-color .12s ease}
/* Hover is an overlay, not a replacement fill: the button keeps its own
   background, so the text keeps its contrast in both themes. */
.mcp-btn::after{content:"";position:absolute;inset:0;border-radius:inherit;
  background:transparent;pointer-events:none;transition:background-color .12s ease}
.mcp-btn:hover::after{background:var(--dsw-alias-interactive-bg-hover)}
.mcp-btn:hover{border-color:var(--dsw-alias-border-l3)}
.mcp-btn:active::after{background:var(--dsw-alias-interactive-bg-active)}
.mcp-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);
  outline-offset:2px}
.mcp-btn[disabled]{opacity:.5;cursor:default}
.mcp-btn[disabled]:hover::after{background:transparent}
.mcp-btn[disabled]:hover{border-color:var(--dsw-alias-border-l2)}
.mcp-btn-primary{background:var(--dsw-alias-button-info-fill);border-color:transparent;
  color:var(--dsw-alias-label-primary-foreground)}
/* 浅色主题的品牌蓝配白字只有 4.23:1；加深一档到 5.39:1，深色主题保持原色。 */
body:not([data-ds-dark-theme]) .mcp-btn-primary{background:var(--dsw-static-deepseek-600)}
.mcp-btn-danger{color:var(--dsw-alias-state-error-primary)}
.mcp-empty{padding:22px 4px;color:var(--dsw-alias-label-tertiary)}
.mcp-note{margin:0 0 12px;padding:8px 10px;border-radius:8px;font-size:12px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.mcp-note-error{background:var(--dsw-alias-interactive-bg-hover-danger);
  color:var(--dsw-alias-state-error-primary)}
.mcp-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  padding:10px 12px;margin:0 0 10px;background:var(--dsw-alias-bg-layer-2)}
.mcp-card-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mcp-name{display:inline-flex;align-items:center;gap:8px;min-width:0;
  font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary)}
.mcp-status{display:inline-block;width:8px;height:8px;flex-shrink:0;border-radius:50%;
  background:var(--dsw-alias-state-idle-primary)}
.mcp-status-active{background:var(--dsw-alias-state-success-primary)}
.mcp-status-pending{background:var(--dsw-alias-state-warn-primary)}
.mcp-status-failed{background:var(--dsw-alias-state-error-primary)}
.mcp-tag{font-size:11px;padding:1px 7px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.mcp-actions{margin-left:auto;display:flex;gap:6px}
.mcp-line{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);
  font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);
  word-break:break-all;white-space:pre-wrap}
.mcp-tools{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.mcp-tool{font-size:11px;padding:1px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.mcp-form{display:grid;gap:10px}
.mcp-field{display:grid;gap:4px;min-width:0;align-content:start}
.mcp-field span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.mcp-field small{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mcp-field input[type=text],.mcp-field textarea,.mcp-field select{
  width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  border-radius:8px;padding:7px 9px;font:inherit;font-size:12px}
.mcp-field input[type=text]:focus,.mcp-field textarea:focus,.mcp-field select:focus{
  outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);
  outline-offset:0;border-color:var(--dsw-alias-border-l3)}
.mcp-field textarea{min-height:64px;resize:vertical;
  font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.mcp-check{display:flex;align-items:center;gap:7px;font-size:12px;
  color:var(--dsw-alias-label-secondary)}
.mcp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mcp-form-actions{display:flex;justify-content:flex-end;gap:8px}
.mcp-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);
  border-radius:8px;overflow:hidden}
.mcp-seg button{appearance:none;border:0;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:5px 12px;
  cursor:pointer;position:relative;transition:color .12s ease}
.mcp-seg button::after{content:"";position:absolute;inset:0;background:transparent;
  pointer-events:none;transition:background-color .12s ease}
.mcp-seg button:not([aria-pressed=true]):hover::after{background:var(--dsw-alias-interactive-bg-hover)}
.mcp-seg button:not([aria-pressed=true]):hover{color:var(--dsw-alias-label-primary)}
.mcp-seg button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);
  outline-offset:-2px}
.mcp-seg button[aria-pressed=true]{background:var(--dsw-alias-button-info-fill);
  color:var(--dsw-alias-label-primary-foreground)}
body:not([data-ds-dark-theme]) .mcp-seg button[aria-pressed=true]{background:var(--dsw-static-deepseek-600)}
@media (min-width:720px){
  .mcp-server-form{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;column-gap:18px}
  .mcp-server-form>.mcp-card-top,.mcp-server-form>.mcp-check,
  .mcp-server-form>.mcp-note,.mcp-server-form>.mcp-form-actions{grid-column:1/-1}
}
@media (max-width:719px){
  .mcp-backdrop{padding:12px}
  .mcp-panel{max-height:calc(100dvh - 24px)}
}
`

    /** Render the panel styles once per mounted panel; unmounting removes them. */
    function StyleSheet() {
      return h('style', { 'data-mcp-manager': '' }, CSS)
    }

    /**
     * Parse `KEY=VALUE` lines into a dictionary, ignoring blank lines.
     *
     * The value is everything after the FIRST `=`, so a value that contains `=`
     * (a query string, a base64 blob, `process.env.X !== '1'`) survives intact.
     * A value the Host rendered as `!!js <expr>` comes back unchanged; the Host
     * turns that prefix back into a Loader expression, so `!!js` headers and env
     * values survive an edit instead of being saved as display text.
     */
    function parsePairs(text) {
      const out = {}
      let previousKey
      for (const line of String(text ?? '').split('\n')) {
        // A tab marks a continuation, including lines with their own "=" or comments.
        if (line.startsWith('\t') && previousKey !== undefined) {
          out[previousKey] += `\n${line.slice(1)}`
          continue
        }
        previousKey = undefined
        const trimmed = line.trim()
        if (trimmed === '' || !trimmed.includes('=')) continue
        const index = trimmed.indexOf('=')
        const key = trimmed.slice(0, index).trim()
        const value = trimmed.slice(index + 1).trim()
        if (key !== '') {
          out[key] = value
          previousKey = key
        }
      }
      return out
    }

    /** Render a dictionary as `KEY=VALUE` lines; values are already strings from the Host. */
    function formatPairs(dict) {
      return Object.entries(dict ?? {}).map(([key, value]) => `${key}=${String(value).replace(/\n/g, '\n\t')}`).join('\n')
    }

    /** The command the panel edits, or an empty stdio draft. */
    function draftOf(server) {
      if (server === undefined) {
        return { serverName: '', transport: 'stdio', command: '', argsText: '', cwd: '', envText: '', url: '', headersText: '', failOnStartupError: false }
      }
      return {
        serverName: server.serverName ?? '',
        transport: server.transport === 'stdio' ? 'stdio' : 'streamable-http',
        command: server.command ?? '',
        argsText: (server.args ?? []).join('\n'),
        cwd: server.cwd ?? '',
        envText: formatPairs(server.env),
        url: server.url ?? '',
        headersText: formatPairs(server.headers),
        failOnStartupError: server.failOnStartupError === true,
      }
    }

    /** Describe one row's transport for the list. */
    function transportLine(server) {
      if (server.transport === 'stdio') {
        const args = server.args.length > 0 ? ` ${server.args.join(' ')}` : ''
        return `${server.command}${args}`
      }
      return server.url
    }

    /** One server row with its edit/remove actions. */
    function ServerCard({ server, t, readOnly, removing, onEdit, onRemove }) {
      const [confirming, setConfirming] = useState(false)
      const phase = server.enabled ? String(server.phase ?? '') : 'disabled'
      const status = ['active', 'failed', 'pending'].includes(phase) ? phase : 'idle'
      const phaseText = t(phase === 'disabled' ? 'row.disabled' : `row.phase.${status === 'idle' ? 'other' : status}`)
      return h('div', { className: 'mcp-card' },
        h('div', { className: 'mcp-card-top' },
          h('span', { className: 'mcp-name' },
            h('span', { className: `mcp-status mcp-status-${status}`, role: 'img', 'aria-label': phaseText, title: phaseText }),
            server.serverName),
          h('span', { className: 'mcp-tag' }, server.transport === 'stdio' ? 'stdio' : 'http'),
          h('span', { className: 'mcp-tag' }, `${server.tools.length} ${t('row.tools')}`),
          !readOnly && h('span', { className: 'mcp-actions' },
            confirming
              ? h(React.Fragment, null,
                h('span', { className: 'mcp-note', style: { margin: 0 } }, t('row.confirmRemove')),
                h('button', { type: 'button', className: 'mcp-btn mcp-btn-danger', disabled: removing, onClick: () => onRemove(server) }, t('row.yes')),
                h('button', { type: 'button', className: 'mcp-btn', onClick: () => setConfirming(false) }, t('row.no')))
              : h(React.Fragment, null,
                h('button', { type: 'button', className: 'mcp-btn', onClick: () => onEdit(server) }, t('row.edit')),
                h('button', { type: 'button', className: 'mcp-btn mcp-btn-danger', onClick: () => setConfirming(true) }, t('row.remove')))),
        ),
        h('p', { className: 'mcp-line' }, transportLine(server)),
        server.tools.length > 0 && h('div', { className: 'mcp-tools' },
          ...server.tools.map((name) => h('span', { className: 'mcp-tool', key: name }, name.replace(`mcp__${server.serverName}__`, '')))),
      )
    }

    /** Add/edit form. */
    function ServerForm({ initial, t, saving, onSubmit, onCancel }) {
      const [draft, setDraft] = useState(initial)
      const [error, setError] = useState('')
      const editing = initial.serverName !== ''
      const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }))
      const submit = (event) => {
        event.preventDefault()
        const name = draft.serverName.trim()
        if (name === '' || (draft.transport === 'stdio' ? draft.command.trim() === '' : draft.url.trim() === '')) {
          setError(t('form.required'))
          return
        }
        setError('')
        onSubmit({
          serverName: name,
          transport: draft.transport,
          command: draft.command,
          args: draft.argsText.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
          cwd: draft.cwd,
          env: parsePairs(draft.envText),
          url: draft.url,
          headers: parsePairs(draft.headersText),
          failOnStartupError: draft.failOnStartupError,
        })
      }
      return h('form', { className: 'mcp-form mcp-server-form', onSubmit: submit },
        h('div', { className: 'mcp-card-top' },
          h('span', { className: 'mcp-name' }, editing ? t('form.editTitle') : t('form.addTitle'))),
        h('label', { className: 'mcp-field' },
          h('span', null, t('form.name')),
          h('input', { type: 'text', value: draft.serverName, disabled: saving, onChange: set('serverName'), autoFocus: true }),
          h('small', null, t('form.nameHint'))),
        h('div', { className: 'mcp-field' },
          h('span', null, t('form.transport')),
          h('div', { className: 'mcp-seg' },
            h('button', { type: 'button', 'aria-pressed': draft.transport === 'stdio', onClick: () => setDraft((c) => ({ ...c, transport: 'stdio' })) }, t('form.stdio')),
            h('button', { type: 'button', 'aria-pressed': draft.transport !== 'stdio', onClick: () => setDraft((c) => ({ ...c, transport: 'streamable-http' })) }, t('form.http')))),
        draft.transport === 'stdio'
          ? h(React.Fragment, null,
            h('label', { className: 'mcp-field' }, h('span', null, t('form.command')), h('input', { type: 'text', value: draft.command, disabled: saving, onChange: set('command') })),
            h('label', { className: 'mcp-field' }, h('span', null, t('form.cwd')), h('input', { type: 'text', value: draft.cwd, disabled: saving, onChange: set('cwd') })),
            h('label', { className: 'mcp-field' }, h('span', null, t('form.args')), h('textarea', { value: draft.argsText, disabled: saving, onChange: set('argsText') })),
            h('label', { className: 'mcp-field' }, h('span', null, t('form.env')), h('textarea', { value: draft.envText, disabled: saving, onChange: set('envText') })))
          : h(React.Fragment, null,
            h('label', { className: 'mcp-field' }, h('span', null, t('form.url')), h('input', { type: 'text', value: draft.url, disabled: saving, onChange: set('url'), placeholder: 'https://example.com/mcp' })),
            h('label', { className: 'mcp-field' }, h('span', null, t('form.headers')), h('textarea', { value: draft.headersText, disabled: saving, onChange: set('headersText') }))),
        h('label', { className: 'mcp-check' },
          h('input', { type: 'checkbox', checked: draft.failOnStartupError, disabled: saving, onChange: (event) => setDraft((c) => ({ ...c, failOnStartupError: event.target.checked })) }),
          t('form.failOnStartup')),
        error !== '' && h('p', { className: 'mcp-note mcp-note-error', style: { margin: 0 } }, error),
        h('div', { className: 'mcp-form-actions' },
          h('button', { type: 'button', className: 'mcp-btn', disabled: saving, onClick: onCancel }, t('form.cancel')),
          h('button', { type: 'submit', className: 'mcp-btn mcp-btn-primary', disabled: saving }, saving ? t('form.saving') : t('form.save'))),
      )
    }

    /** Import standard MCP JSON without exposing credentials in the preview. */
    function ImportForm({ t, remote, onImported, onCancel, onBusy }) {
      const [text, setText] = useState('')
      const [servers, setServers] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const locked = useRef(false)
      const updateText = (value) => {
        setText(value)
        setServers(null)
        setError('')
      }
      const run = async (operation) => {
        if (locked.current) return
        locked.current = true
        setBusy(true)
        onBusy(true)
        setError('')
        try {
          await operation()
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error))
        } finally {
          locked.current = false
          setBusy(false)
          onBusy(false)
        }
      }
      const chooseFile = (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        updateText('')
        void run(async () => {
          if (file.size > 1024 * 1024) throw new Error(t('import.tooLarge'))
          let value
          try { value = await file.text() } catch { throw new Error(t('import.readFailed')) }
          updateText(value)
        })
      }
      const preview = (event) => {
        event.preventDefault()
        void run(async () => {
          setServers(null)
          if (new Blob([text]).size > 1024 * 1024) throw new Error(t('import.tooLarge'))
          const result = await remote.previewImport(text)
          if (!result.ok) throw new Error(result.message)
          setServers(result.value.servers)
        })
      }
      const commit = () => {
        if (servers === null) return
        void run(async () => {
          const result = await remote.importServers(text)
          if (!result.ok) {
            setServers(null)
            throw new Error(result.message)
          }
          await onImported(result.value.imported)
        })
      }
      return h('form', { className: 'mcp-form', onSubmit: preview },
        h('h3', { className: 'mcp-name', style: { margin: 0 } }, t('import.title')),
        h('p', { className: 'mcp-sub' }, t('import.hint')),
        h('label', { className: 'mcp-field' },
          h('span', null, t('import.file')),
          h('input', { type: 'file', accept: '.json,application/json', disabled: busy, onChange: chooseFile })),
        h('label', { className: 'mcp-field' },
          h('span', null, t('import.source')),
          h('textarea', { value: text, disabled: busy, rows: 8, autoFocus: true, spellCheck: false,
            placeholder: '{"mcpServers":{"example":{"command":"npx","args":["-y","example-mcp"]}}}',
            onChange: (event) => updateText(event.target.value) })),
        servers !== null && h('div', { className: 'mcp-card', 'aria-live': 'polite' },
          h('p', { className: 'mcp-sub' }, `${t('import.ready')}${servers.length}`),
          h('ul', null, ...servers.map((server) => h('li', { key: server.serverName },
            server.serverName, ' ', h('span', { className: 'mcp-tag' }, server.transport === 'stdio' ? 'stdio' : 'http'))))),
        error !== '' && h('p', { className: 'mcp-note mcp-note-error', role: 'alert' }, error),
        h('div', { className: 'mcp-form-actions' },
          h('button', { type: 'button', className: 'mcp-btn', disabled: busy, onClick: onCancel }, t('form.cancel')),
          h('button', { type: 'submit', className: 'mcp-btn', disabled: busy || text.trim() === '' }, busy ? t('import.busy') : t('import.preview')),
          servers !== null && h('button', { type: 'button', className: 'mcp-btn mcp-btn-primary', disabled: busy, onClick: commit }, t('import.confirm'))))
    }

    /** The floating panel: list, add, edit, remove and import. */
    function McpPanel({ t, remote, onClose }) {
      const [state, setState] = useState({ status: 'loading', manage: true, servers: [], error: '' })
      const [editing, setEditing] = useState(null)
      const [importing, setImporting] = useState(false)
      const [notice, setNotice] = useState('')
      const [saving, setSaving] = useState(false)
      const [removing, setRemoving] = useState('')
      const [actionError, setActionError] = useState('')
      const mounted = useRef(true)

      useEffect(() => () => { mounted.current = false }, [])

      const load = useCallback(async () => {
        setState((current) => ({ ...current, status: 'loading', error: '' }))
        const result = await remote.list()
        if (!mounted.current) return
        if (!result.ok) {
          setState({ status: 'error', manage: true, servers: [], error: result.message })
          return
        }
        setState({ status: 'ready', manage: result.value.manage !== false, servers: result.value.servers ?? [], error: '' })
      }, [remote])

      useEffect(() => { void load() }, [load])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (saving) return
          if (importing) setImporting(false)
          else if (editing !== null) setEditing(null)
          else onClose()
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [editing, importing, saving, onClose])

      const submit = async (server) => {
        setSaving(true)
        setActionError('')
        const result = await remote.save(server)
        if (!mounted.current) return
        setSaving(false)
        if (!result.ok) {
          setActionError(result.message)
          return
        }
        setEditing(null)
        await load()
      }

      const remove = async (server) => {
        setRemoving(server.serverName)
        setActionError('')
        const result = await remote.remove(server.serverName)
        if (!mounted.current) return
        setRemoving('')
        if (!result.ok) {
          setActionError(result.message)
          return
        }
        await load()
      }

      const readOnly = state.status === 'ready' && !state.manage
      const rows = useMemo(() => state.servers.map((server) => h(ServerCard, {
        key: server.rowId,
        server,
        t,
        readOnly,
        removing: removing === server.serverName,
        onEdit: (value) => setEditing(draftOf(value)),
        onRemove: (value) => { void remove(value) },
      })), [state.servers, readOnly, removing, t])

      return h('div', { className: 'mcp-backdrop', role: 'presentation', onMouseDown: (event) => { if (!saving && event.target === event.currentTarget) onClose() } },
        h(StyleSheet),
        h('div', { className: 'mcp-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('panel.aria') },
          h('div', { className: 'mcp-head' },
            h('div', null,
              h('h2', null, t('panel.title'))),
            h('div', { className: 'mcp-head-actions' },
              h('button', { type: 'button', className: 'mcp-btn', disabled: saving || importing, onClick: () => { void load() } }, t('panel.refresh')),
              h('button', { type: 'button', className: 'mcp-btn', disabled: saving, onClick: onClose, 'aria-label': t('panel.close') }, '✕'))),
          h('div', { className: 'mcp-body' },
            readOnly && h('p', { className: 'mcp-note' }, t('panel.readOnly')),
            actionError !== '' && h('p', { className: 'mcp-note mcp-note-error' }, actionError),
            notice !== '' && h('p', { className: 'mcp-note', role: 'status' }, notice),
            importing && h(ImportForm, {
              t, remote, onBusy: setSaving,
              onCancel: () => setImporting(false),
              onImported: async (count) => {
                setNotice(`${t('import.done')}${count}`)
                setImporting(false)
                await load()
              },
            }),
            state.status === 'loading' && h('p', { className: 'mcp-empty' }, t('panel.loading')),
            state.status === 'error' && h('div', null,
              h('p', { className: 'mcp-note mcp-note-error' }, `${t('panel.failed')}: ${state.error}`),
              h('button', { type: 'button', className: 'mcp-btn', onClick: () => { void load() } }, t('panel.retry'))),
            state.status === 'ready' && !importing && rows.length === 0 && editing === null && h('p', { className: 'mcp-empty' }, t('panel.empty')),
            state.status === 'ready' && !importing && editing === null && rows,
            editing !== null && h(ServerForm, {
              initial: editing,
              t,
              saving,
              onSubmit: (server) => { void submit(server) },
              onCancel: () => setEditing(null),
            }),
            state.status === 'ready' && editing === null && !importing && !readOnly && h('div', { className: 'mcp-row', style: { marginTop: 12 } },
              h('button', { type: 'button', className: 'mcp-btn mcp-btn-primary', onClick: () => { setNotice(''); setEditing(draftOf(undefined)) } }, t('panel.add')),
              h('button', { type: 'button', className: 'mcp-btn', disabled: removing !== '', onClick: () => { setNotice(''); setActionError(''); setImporting(true) } }, t('import.title')))),
        ))
    }

    /**
     * Post one panel operation to the Host's exact Fetch route.
     *
     * The route is mounted on the authenticated `/api` bridge, so a plain
     * same-origin `fetch` carries the browser credential. The path is relative
     * because the shipped Client code posts the same way (`api/<endpoint>`), and
     * the Desktop page (`dsh-app://app`) resolves it against `streamBaseUrl`.
     *
     * @param {object} body Operation payload.
     * @returns {Promise<{ ok: true, value: any } | { ok: false, message: string }>}
     */
    async function call(body) {
      let response
      try {
        response = await fetch('api/mcp.manager', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      const text = await response.text().catch(() => '')
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        return { ok: false, message: `HTTP ${response.status}: ${text.slice(0, 200)}` }
      }
      if (!response.ok || payload.error !== undefined) {
        return { ok: false, message: String(payload.error?.message ?? `HTTP ${response.status}`) }
      }
      return { ok: true, value: payload.value }
    }

    /** The Host operations the panel drives. */
    const api = {
      list: () => call({ action: 'list' }),
      save: (server) => call({ action: 'save', server }),
      remove: (serverName) => call({ action: 'remove', serverName }),
      previewImport: (text) => call({ action: 'previewImport', text }),
      importServers: (text) => call({ action: 'import', text }),
    }

    /** The session-scoped overlay that renders the panel while it is open. */
    function McpPanelEntry({ t, api, open }) {
      const [visible, setVisible] = useState(() => open.get() === true)
      useEffect(() => {
        // Read the shared value on mount, then follow it: a `/mcp` run that
        // happened before this overlay mounted is already reflected in `open`,
        // so the panel never depends on which React effect ran first.
        setVisible(open.get() === true)
        return open.subscribe(() => setVisible(open.get() === true))
      }, [open])
      if (!visible) return false
      return createPortal(
        h(McpPanel, { t, remote: api, onClose: () => open.set(false) }),
        document.body,
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-manager: dictionaries')
      const t = ctx.locale.bind(NS)
      /** Per-Session open state shared by the command action and the overlay. */
      const panels = new Map()
      const panelFor = (sessionId) => {
        let panel = panels.get(sessionId)
        if (panel === undefined) {
          const listeners = new Set()
          let value = false
          panel = {
            get: () => value,
            set: (next) => {
              if (value === next) return
              value = next
              for (const listener of listeners) listener()
            },
            toggle: () => {
              value = !value
              for (const listener of listeners) listener()
            },
            subscribe: (listener) => {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
          }
          panels.set(sessionId, panel)
        }
        return panel
      }

      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'mcp-manager',
        order: 40,
        locale: NS,
        inject: (sessionId) => ({ open: panelFor(sessionId), api }),
      }, McpPanelEntry))

      ctx.inject(['commandUi'], (scope) => {
        scope.effect(() => scope.commandUi.register({
          name: 'mcp',
          available: () => true,
          label: () => t('command.mcp.label'),
          description: () => t('command.mcp.description'),
          icon: McpMenuIcon,
          ui: {
            kind: 'action',
            run: (session) => {
              panelFor(session.sessionId).toggle()
            },
          },
        }), 'mcp-manager: /mcp command')
      })
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
