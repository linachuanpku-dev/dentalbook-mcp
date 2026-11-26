# Dentalbook Web 与 Cloudflare Tunnel 部署

## 当前事实

- Cloudflare MCP 已能读写账户。
- `example.com` zone 为 active。
- 远程管理 Tunnel `dentalbook-linux`（`1946ce70-03e0-4be5-a5df-5c6f230464bd`）已创建，Linux `cloudflared` systemd connector 为 healthy。
- 唯一新增 DNS：proxied CNAME `dentalbook.example.com` → `<tunnel-id>.cfargotunnel.com`。未改根域名、`node`、`seoul` 或全域 SSL。
- Linux 中心由 `dentalbook-center.service` 以 `dentalbook` 用户监听 `127.0.0.1:7342`；发布目录 `/opt/dentalbookv5` → `/opt/dentalbookv5-releases/20260819-221031`。
- Cloudflare Access 尚未启用；第一版使用 Dentalbook 自己的短期 Web 会话和每用户独立 Token。

## 目标入口

`https://dentalbook.example.com` → Cloudflare Tunnel → Linux `http://127.0.0.1:7342`

中心仍只绑定回环地址。Tunnel 与中心运行在同一 Linux 主机，因此回环段可显式使用 HTTP；公网侧始终是 Cloudflare HTTPS。不能把 `7342` 开到局域网或公网。

Agent 通过本机用户 MCP（stdio 或回环 Streamable HTTP `/mcp`）调用同一中心 HTTPS API。第一版不把完整用户 MCP 发布到 `https://dentalbook.example.com/mcp`；该路径仅预留给未来远程只读适配器。

## Linux 文件布局

| 路径 | 内容 |
|---|---|
| `/opt/dentalbookv5` | 构建后的仓库代码与 Web 静态资源 |
| `/opt/dentalbookv5/releases/mcp-user` | 预构建 user MCP tarball、manifest 与 install 脚本 |
| `/etc/dentalbook/center.env` | 中心非秘密配置，权限 `0640` |
| `/var/lib/dentalbook-test-library/secrets/users.json` | 哈希后的用户配置（`userId`、token SHA-256、scopes；可选 `displayName`），权限 `0640` |
| `/var/lib/dentalbook-test-library/db/shared.sqlite3` | 中心 SQLite/WAL |
| `/var/lib/dentalbook-test-library/objects` | 内容寻址 PDF |
| `/var/lib/dentalbook-test-library/fixtures/authors/*.jsonl` | 作者名录夹具（不进 Git）；启动时 upsert 进标准作者库 |

systemd 模板见 [`deploy/linux/dentalbook-center.service`](../deploy/linux/dentalbook-center.service)，环境模板见 [`deploy/linux/center.env.example`](../deploy/linux/center.env.example)。真实 Token、Tunnel token 和用户文件不得写入仓库或 AirDrop 包。

## 上线顺序

1. Mac A 执行 `npm ci` 与 `npm run check`。
2. 将代码传到 Linux 的新发布目录，不覆盖活动数据目录。
3. Linux 再执行 `npm ci --omit=dev=false`、`npm run build`；若 MCP / install 脚本有变更，再执行 `npm run build:mcp-release`。
4. 确认 `DENTALBOOK_RELEASES_DIR`（默认 `/opt/dentalbookv5/releases/mcp-user`）含 `manifest.json`、`latest.tar.gz`、`install-mcp-user.sh`。
5. 安装 `dentalbook-center.service`，先只在回环启动。
6. 在 Linux 本机验证 `/v1/health`、Web 登录、文献列表、作者列表和 PDF 下载。
7. 验证 MCP 分发：`curl -fsS http://127.0.0.1:7342/releases/mcp-user/manifest.json` 与 `curl -fsS http://127.0.0.1:7342/install/mcp-user.sh | head -1`。
8. 在 Cloudflare 创建远程管理 Tunnel `dentalbook-linux`。
9. 在 Linux 安装官方 `cloudflared` systemd connector；Tunnel token 只进入 root 可读的服务环境，不进入命令历史或项目。
10. 新增唯一 published application：`dentalbook.example.com` → `http://127.0.0.1:7342`，并保留 catch-all `http_status:404`。
11. 从 Mac A、Mac B 和一台非本地网络设备验收 HTTPS、登录、列表与下载。

## Cloudflare 变更边界

- 只新增一个 Tunnel、一个 `library` 子域名路由和对应 DNS 记录。
- 不修改根域名 `example.com`、`node`、`seoul` 或全域 SSL 模式。
- 第一版不启用 Cloudflare Access，避免浏览器身份层与 MCP Bearer Token 同时上线。需要邮件 OTP 或机构 SSO 时另开一轮设计。
- PDF 响应为 `private, no-store`，不得配置公共 Cache Rule。

## 验收

```bash
curl -fsS http://127.0.0.1:7342/v1/health
curl -fsS https://dentalbook.example.com/v1/health
curl -fsS https://dentalbook.example.com/releases/mcp-user/manifest.json
```

## MCP 发布（建设者）

| 改动类型 | Linux 动作 | 重打 tarball |
|---|---|---|
| 仅 center / Web | `npm run build` + 重启 center | 否 |
| mcp-user / mcp-ui / install 脚本 | `npm run build && npm run build:mcp-release` | 是 |
| domain-contracts 破坏性变更 | 两侧一起发 | 是 |

步骤：`git push` → Linux `npm ci && npm run build && npm run build:mcp-release` → 确认 `releases/mcp-user/manifest.json` 的 `sha256` 与 `latest.tar.gz` 一致 → 重启 center。

医生升级级别：L0 中心/Web 单独更新；L1 `upgradeRecommended` + docs；L2 `upgradeRequired` + Web 横幅 + 群发升级 Prompt。

浏览器验收：

1. 未登录不能访问 `/web/api/v1/papers`。
2. 登录响应设置 `HttpOnly; SameSite=Strict; Secure` 会话 Cookie，响应体不包含长期 Token。
3. 刷新页面保持登录；退出后会话立即失效。
4. 文献计数与 MCP `library.stats` 一致。
5. PDF 下载响应包含 `application/pdf`、附件文件名与 `x-dentalbook-sha256`。文献卡片分两步显示元信息上传与 PDF 上传（admin/user、时间、渠道）；每篇题录都有元信息时间/渠道，PDF 无回执时显示「尚无」。DOI 下可打开原文链接（doi.org）。论文栏显示 keywords：绿为已抓到的词，黄为问过但空，灰为未尝试。
6. 作者库显示真实作者记录；没有作者数据时显示空状态，不生成演示作者。作者关系只显示管理员已通过的投稿，并带上传者、上传时间、审核者和审核时间。
7. 管理员（`admin:audit` / `authors:admin` / `fulltext:fetch`）右上角有「用户请求记录」，可打开 `/users` 与 `/users/:userId` 时间线（检索组 + 文献行）；医生视图没有该按钮，直接打用户 API 为 403。可选在 Linux 补 `displayName`，仓库不提交真实 `users.json`。
8. 有 `authors:admin` 的管理员右上角有「作者消歧审核」，打开 `/author-merges` 与 `/author-merges/:authorId`：人是否钉住、五路是否问过、作品并集来源、冲突，可确认或退回。医生没有该按钮；医生作者页不显示检索日志。作者卡显示五路来源胶囊；管理员可下拉两次 v3 导入时间（名录/论文）。合并写入用离线脚本 + `POST /v1/authors/merges/ingest`，论文导入用 `POST /v1/authors/works/ingest`，不把真实 v3 JSONL 提交进 Git。

## 回滚

1. 删除或停用 `dentalbook.example.com` 的 Tunnel route/DNS 记录。
2. 停止 `cloudflared` connector。
3. 保留只绑定回环的 Dentalbook 中心服务和全部数据，不删除数据库或 PDF。
4. 若新版本应用失败，把 `/opt/dentalbookv5` 切回上一发布目录并重启中心服务；数据库回滚必须使用事先验证的一致性备份，不能直接覆盖活动 WAL 文件。
