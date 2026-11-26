# ADR-005：Web 主界面与开放 MCP 共用领域服务

- 状态：已接受
- 日期：2026-08-18

## 决策

Dentalbook 先提供可独立访问的轻量 Web 文献库，作为医生浏览、搜索和下载的稳定主界面；Codex、Claude 等通用 Agent 通过开放 MCP 使用同一套领域能力。Web、MCP、管理入口都只能调用统一应用服务，不分别实现题录、全文、作者或权限规则。

## 理由

MCP Apps 的展示位置、缓存和刷新行为由宿主控制，不适合作为医生唯一入口。稳定 Web 地址可以直接验收真实列表与下载，也让没有 MCP Apps 能力的设备使用同一共享库。MCP 仍是 Agent 友好的自动化和自然语言入口，而不是 UI 的运行依赖。

## 后果

- Linux 中心同时托管 Web 静态资源、版本化领域 API、SQLite 和内容寻址 PDF。
- Web 使用短期 HttpOnly 会话；MCP 使用每用户独立 Bearer Token。
- 开放 MCP 的通用协议是 Streamable HTTP `/mcp`；stdio 只是本机适配器。Cursor、Codex 和 Claude 连接同一工具目录。
- `https://dentalbook.example.com/mcp` 预留给未来的远程只读适配器，第一版不把带本机缓存/上传的完整用户 MCP 挂到公网。
- MCP Apps 保留为内联辅助视图，不再承担主界面职责。
- 第一版通过 Cloudflare Tunnel 发布单一子域名 `dentalbook.example.com`。
