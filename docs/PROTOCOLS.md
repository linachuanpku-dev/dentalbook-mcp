# 标准协议与边界

## 1. 采用的标准

| 标准 | 用途 | Dentalbook 约束 |
|---|---|---|
| MCP | Agent 与 Dentalbook 工具、资源通信 | 通用接口为 Streamable HTTP `POST /mcp` + Bearer；stdio 是本机适配器。用户与管理权限面分离 |
| MCP Apps | 在兼容宿主中显示交互 UI | 标准 bridge 优先，业务必须可无 UI 降级 |
| Agent Skills | 描述可移植的领域流程和语言约束 | 不保存秘密，不承担授权、事务或真实性 |
| HTTPS + JSON | 本地网关访问中心领域 API | 独立版本、超时、幂等键和错误码 |
| HTTPS + Web session | 医生浏览器访问共享 Web | 长期 Token 只换取短期 HttpOnly Cookie |
| Bearer Token | 小圈子 v1 身份认证 | 每用户独立、服务端只存哈希、可过期和吊销 |
| SHA-256 | PDF 内容身份、证明失效与内容寻址 | 不是数字签名，不替代许可与来源审计 |
| SQLite/WAL | 中心与本地持久化 | 单写者约束、事务、备份前 checkpoint |

## 2. 为什么不用 ACP

ACP 适合宿主与独立 Agent 运行时之间的会话、终端和编辑协议。v5 不提供自己的 Agent 运行时，因此没有 ACP 边界。Codex 或 Claude 自己负责推理和会话；Dentalbook 只通过 MCP 暴露领域能力。

## 3. Skills 与 MCP 的分工

Skills 说明“怎样完成任务”，例如先确认题录与 PDF 状态，再建立证据卡，最后审核引用。MCP 提供可执行、可验证的动作。业务耦合流程由应用服务封装成单个用例工具；不能依赖 Skill 要求模型以固定顺序调用多个低层工具来模拟事务。

## 4. CLI 与内部 API

- CLI 是管理员进行脚本化维护、灾备和故障诊断的入口；它与 MCP 复用同一应用服务。
- 内部 API 连接本机和中心，适合长任务、文件流、同步与服务间调用；它不是给模型直接推理的工具目录。
- MCP 是 Agent 面向意图的接口，参数和结果应紧凑、稳定、可解释。
- Web 是人的稳定主界面，与 MCP 共用应用服务；Web 不直接访问 SQLite 或内容库路径。

## 5. MCP Apps 基线

- UI 资源 URI 使用版本号作为缓存键。
- MIME 类型为 `text/html;profile=mcp-app`。
- 渲染工具用 `_meta.ui.resourceUri` 关联资源。
- UI 通过 `ui/*` JSON-RPC bridge 接收输入和结果，通过 `tools/call` 执行动作。
- `window.openai` 只做能力探测后的可选增强。
- 工具仍返回 `structuredContent`、文字说明和标准链接，供无 UI 宿主使用。

实现基线来自 [OpenAI MCP UI 文档](https://developers.openai.com/plugins/build/chatgpt-ui)；开放标准本身见 [MCP Apps specification](https://modelcontextprotocol.io/docs/extensions/apps)。

## 6. 不自建的内容

- 不自建工具发现、参数 schema、资源读取或 UI bridge 协议。
- 不自建 Agent 会话协议。
- 不发明 PDF 内容 ID；使用 SHA-256。
- 不发明引用交换格式；未来导出层优先使用 CSL JSON、BibTeX 或 RIS，但内部证明对象保持 Dentalbook 专用扩展。

## 7. 仍需自定义的领域协议

标准不会定义“PDF 已核验”“原句 exact”“作者关系人工认定”或“changeset 回滚”。这些属于 Dentalbook 的核心资产，必须以版本化领域契约实现，并通过 MCP/API/CLI 共享同一语义。
