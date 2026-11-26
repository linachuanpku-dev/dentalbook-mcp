# MCP Apps UI 设计

## 1. 产品承诺

Dentalbook 承诺兼容宿主中的对话内联 UI，并在宿主提供能力时请求全屏。不承诺固定右侧栏、固定宽度或宿主导航入口。无 UI 时，工具必须完整返回文字和结构化结果。

MCP Apps 资源通过 iframe 运行，标准 bridge 使用 JSON-RPC over `postMessage`。OpenAI 也建议数据工具与渲染工具分离，并优先从内联视图开始。[官方说明](https://developers.openai.com/plugins/build/chatgpt-ui)

## 2. 独立资源

| URI | 内联 | 全屏 |
|---|---|---|
| `ui://dentalbook/library/v1` | 共享数量、文献列表、可下载/本机状态、下载按钮 | 搜索与更长列表；当前内联与全屏使用同一响应式布局 |
| `ui://dentalbook/notebooks/v1` | 最近笔记本、篇数、同步状态 | 创建、重命名、删除、移动论文、抓取状态 |
| `ui://dentalbook/citations/v1` | 题录、PDF、原句和页码状态 | 审计原因、上下文和同 SHA 页面缩略图 |
| `ui://dentalbook/author-map/v1` | 小地图与选中对象摘要 | MapLibre 世界地图、机构点与作者详情 |
| `ui://dentalbook/author-graph/v1` | 当前作者和关键关系 | 合作者、师承、团队、可信度与来源回溯 |
| `ui://dentalbook/system-probe/v2` | 宿主兼容性检查（固定浅色） | 可选全屏检查 |

URI 版本是缓存键。破坏性改变必须发布新 URI。

## 3. 状态所有权

| 状态 | 所有者 | 示例 |
|---|---|---|
| 业务真相 | 领域服务 | 笔记本名称、证据卡、作者关系、changeset |
| 模型可见结果 | MCP `structuredContent` | 当前列表、引用状态、图谱摘要 |
| UI 专用结果 | MCP 结果 `_meta` | 大型布局、缩略图临时 URL |
| 临时视图状态 | iframe | 选中节点、缩放、过滤、展开面板 |

刷新后必须能从服务端结果重建业务画面。UI 不直接写数据库，也不把成功状态先行乐观提交。

## 4. 写入流程

1. 用户在 UI 中发起动作。
2. UI 用标准 `tools/call` 调业务工具。
3. 工具校验身份、版本与确认令牌，在事务内写入。
4. UI 只在收到 `ok: true` 的真实回执后更新成功状态。
5. 失败时保留原状态并显示服务端错误码。

## 5. 引用点击

默认先打开 Dentalbook 证据卡，显示题录、`PdfProof`、`QuoteProof`、页码、原句上下文、文件哈希摘要和验证时间。用户再选择“定位本地 PDF”。第一版不在 iframe 中嵌入完整 PDF 阅读器。

## 6. CSP

每个资源声明最小 allowlist：

- 笔记本、引用、作者关系图默认不需要网络域。
- 作者地图只允许明确的地图样式、瓦片、图片和 Dentalbook API 域。
- 禁止通配域，域变更要经过安全审阅。
- 下载或打开外部资源由宿主能力和用户批准控制。

当前所有资源的 CSP 域数组为空；共享文献库 UI 的读取和下载都通过 `tools/call`，不直接联网。地图业务实现前不得预先放宽。

## 7. 共享文献库验收

- Mac A、Mac B 的共享题录数与共享 PDF 数一致。
- `central_cached` 显示“共享库可下载”，点击后才调用 `sync.pull_pdf`。
- 下载拿到真实 `local_sync_*` 回执并复核 SHA 后，当前 Mac 行状态才变为“本机已有”。
- 另一台 Mac 不会因为本机下载而错误显示 `local`。
- `metadata_only` 显示“仅题录”且下载按钮禁用。
- 搜索和刷新重新调用 `papers.list`，不能只筛选旧的 iframe 假数据。

## 8. Probe 验收

`system.render_ui_probe` 只验证：

- `text/html;profile=mcp-app` 资源能被读取和内联显示。
- 固定浅色样式中的文字、边框和按钮可读；不提供深色主题。
- 按钮通过标准 `tools/call` 调用 `system.health`。
- 若存在 `window.openai.requestDisplayMode`，可请求全屏；不存在则诚实提示内联降级。

探针不访问中心 API、本地数据库、论文或用户数据。
