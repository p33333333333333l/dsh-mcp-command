# dsh-mcp-command

给 DSH 加一个 `/mcp` 斜杠命令：输入即弹出面板，查看和管理 MCP 服务器。

不用再手改 `cordis.patch.yml` 来增删 MCP 服务器。

## 能做什么

- **查看**：当前 profile 里配置的所有 MCP 服务器、连接方式（stdio / 远程 HTTP）、运行状态、已暴露给模型的工具名。
- **新增**：填写服务器名、连接方式、命令或地址，保存后立刻写入 profile 配置并重载 MCP 客户端。
- **编辑**：修改已有服务器的命令、参数、环境变量、地址、请求头。
- **删除**：从 profile 配置里移除整个服务器。

命令在菜单里显示为「MCP 服务器」，带独立图标；按钮文字跟随界面语言（中文 / English）。

## 安装

在 DSH 里添加插件市场索引，或直接用插件管理器安装：

```
git+https://github.com/p33333333333333l/dsh-mcp-command.git
```

装好后重启或刷新页面，输入 `/mcp` 即可。

## 怎么用

1. 在对话输入框输入 `/mcp`，从命令列表里选「MCP 服务器」；或直接输入 `/mcp` 回车。
2. 面板弹出，列出所有服务器。
3. 点「添加服务器」新增，或在某一行点「编辑」/「删除」。

再次输入 `/mcp` 或按 `Esc` 关闭面板。

## 服务器配置填什么

**本地进程（stdio）**

| 字段 | 说明 |
|---|---|
| 服务器名 | 工具前缀，只能字母数字下划线连字符，最长 32 字符 |
| 命令 | 可执行文件路径，例如 `/usr/bin/node` 或 `npx` |
| 参数 | 每行一个 |
| 工作目录 | 可选 |
| 环境变量 | 每行 `KEY=VALUE` |

**远程 HTTP**

| 字段 | 说明 |
|---|---|
| 服务器名 | 同上 |
| 服务地址 | 例如 `https://example.com/mcp` |
| 请求头 | 每行 `NAME=VALUE`，可用于 `Authorization` |

「连接失败时阻止启动」勾选后，服务器连不上会导致该插件激活失败。

工具在模型侧显示为 `mcp__<服务器名>__<工具名>`。

## 改了什么文件

写入落在当前 profile 的 `cordis.patch.yml`：新增和删除改动 `insert` 列表，编辑已有服务器只改该行的 `config`。注释、其它配置行和 `!!js` 表达式保持原样。

## 它会写你的配置

这是会修改 DSH 配置文件的插件，每次保存或删除都会改写 `cordis.patch.yml`。

- **先备份**：第一次使用前，把 `~/.dsh/profiles/<profile>/cordis.patch.yml` 复制一份。
- **删除会连带移除工具**：删掉一个服务器，它提供给模型的全部工具会立即消失。面板会要求二次确认。
- **保存会重连**：改动后 MCP 客户端重新加载，正在进行的工具调用可能中断。

保护措施：

- 写入前校验服务器名格式和必填字段，非法输入不会落盘。
- 写入加文件锁，避免并发写坏文件。
- 写入后若 Loader 重新装配失败，自动回滚到改动前的字节。

## 安全性

- 面板只能通过已认证的浏览器会话访问（走 DSH 自己的 Connection 通道）。
- 插件配置里 `manage: false` 可把它变成只读。

## 配置

`cordis.patch.yml` 里的插件行可加 `config`：

```yaml
- insert:
    - id: mcp-manager
      name: 'dsh-mcp-command'
      config:
        manage: true    # false 则面板只读
```

## 已知限制

- 面板管理的是**当前 profile** 的 MCP 行；其它 profile 需要各自安装本插件。
- 不在 `insert` 列表里、而是以顶层 override 形式存在的 MCP 行，面板会显示但删除会拒绝，需要手工改配置。

## 结构

```
host/index.js           Host 半：RPC 路由、McpManager（列表/保存/删除/校验）
host/patch-doc.js       profile patch 的纯文档编辑（保留注释与 !!js）
host/profile-patch.js   加锁写入 + Loader 重新装配，失败回滚
client/client.js        浏览器半：/mcp 命令、面板、图标、中英文字典
cordis.patch.yml        bundle patch：插入插件行
locale/{en,zh}.json     插件管理器显示的标题与描述
```

## 协议

[Apache License 2.0](LICENSE)
