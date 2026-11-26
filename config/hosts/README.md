# 宿主接入示例

这些文件是模板，不会自动写入用户级 Codex、Claude、Cursor 或 WorkBuddy 配置。

**医生（零 GitHub）：** 从 `https://dentalbook.example.com/install/mcp-user.sh` 安装，产物在 `~/.dentalbook/mcp-user/current/`。示例见 `workbuddy.example.json`、`trae.example.json`、`qoder.example.json`。

**建设者（仓库开发）：** 先运行 `npm install && npm run build`。Codex 插件用根目录 `.mcp.json`；Cursor 项目配置是 `.cursor/mcp.json`，启动 `scripts/start-user-mcp.sh`。
- 用户 Streamable HTTP 示例见 `user-streamable-http.example.json`；先运行 `./scripts/start-user-mcp-http.sh`，令牌只放进环境变量，不写入仓库。
- 管理 MCP HTTP 示例见 `admin-streamable-http.example.json`；生产端点必须使用 TLS。本机验收可连接只监听 `127.0.0.1` 的临时 HTTP 管理 MCP。
- 本机构建者 stdio 示例见 `admin-stdio.example.json`，命令为 `scripts/start-admin-mcp-stdio.sh`。中心 URL 与 Bearer 只放进 gitignore 的 `.dentalbook-local/admin.env`，不写入仓库。

医生侧只配置 `dentalbook-user`。不要把 `dentalbook-admin` 端点或令牌放入医生插件或项目 `.cursor/mcp.json`。本机 Cursor 用户级配置可以单独加管理 MCP，供建设者 Fetch。
