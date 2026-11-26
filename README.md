# Dentalbook

### 给口腔医生的私有文献库，也能接到 Cursor、Codex 和 Claude

[![Web](https://img.shields.io/badge/使用入口-dentalbook.example.com-0F766E)](https://dentalbook.example.com/)
[![Docs](https://img.shields.io/badge/文档-医生接入-111827)](https://dentalbook.example.com/docs)
[![MCP](https://img.shields.io/badge/MCP-Cursor%20%7C%20Codex%20%7C%20Claude-6366F1)](https://dentalbook.example.com/docs?section=cursor)
[![Node](https://img.shields.io/badge/node-22%2B-339933)](https://nodejs.org/)

### 使用入口：**[dentalbook.example.com](https://dentalbook.example.com/)**

中文 | [English](README_EN.md) | [医生接入文档](https://dentalbook.example.com/docs)

---

## 这是什么

医生查文献、下全文、摘证据、写综述，通常散落在浏览器、网盘和聊天窗口里。通用 Agent 会写字，但并不拥有一份可核对的私有文献库。

**Dentalbook** 先把共享论文目录、受控 PDF 和基础作者索引放进一个稳定网页；同一份数据再通过开放 MCP 提供给 Cursor、Codex、Claude 等你已经在用的工具。它不是又一个聊天应用，也不会取代你正在用的模型。

当前第一版已经可以在浏览器里检索、下载，并在 Agent 里列出、上传和同步同一批文献。笔记本、可信引用和综述工具还在后面，不会假装已经完成。

## 你现在可以做什么

- **浏览器里用同一套文献库** — 登录后即可搜索共享目录、查看题录、下载已缓存 PDF、浏览基础作者索引
- **分清文献状态** — 清楚区分「只有题录」「中心有 PDF」「我这台电脑已下载」
- **把同一份库接到 Agent** — 在 Cursor / Codex / Claude 里调用同一套医生侧 MCP，不另外做一个桌面聊天窗
- **本机上传到共享库** — 从你指定的文件夹导入 PDF；成功后会拿到真实回执，而不是占位成功
- **按需把 PDF 拉到本机** — 中心已有全文时，再同步到你自己的本地库
- **管理员单独抓取全文** — Fetch 只在管理 MCP 里，不会混进医生工具

## 接下来会做什么

- 本地笔记本、阅读状态与高亮
- 把引用绑到同一份 PDF 的页码和原句
- 可信综述与作者关系图
- 更完整的令牌、备份和审计工具

医学事实和正式结论默认仍会要求可核对的引用，不会用模型自己编的出处交差。

## 快速开始

### 1. 用浏览器

1. 打开 **[dentalbook.example.com](https://dentalbook.example.com/)**
2. 使用管理员发给你的访问令牌登录（管理员和医生进的是同一套页面）
3. 在文献库里搜索、打开题录、下载已缓存的 PDF

不装 Cursor 也能完成检索和下载。

### 2. 接到 Cursor / Codex / Claude

完整步骤、可复制配置和一键 Prompt 在这里：

**[dentalbook.example.com/docs](https://dentalbook.example.com/docs)**

简要流程：

1. 本机安装 Node.js 22+，克隆本仓库后执行 `npm install && npm run build`
2. 向管理员索取**医生侧**访问令牌（与网页登录是同一把）
3. 在本机创建 gitignore 文件 `.dentalbook-local/user.json`（权限 `0600`），不要把令牌写进仓库
4. Cursor 使用仓库内 `.cursor/mcp.json`；Codex 使用仓库插件和根目录 `.mcp.json`
5. 重载 MCP 后调用 `system.health` 与 `library.stats`，确认中心可达、数量对得上

医生只配置 `dentalbook-user`。不要把管理 MCP 写进日常插件。

```json
{
  "mcpServers": {
    "dentalbook-user": {
      "command": "./scripts/start-user-mcp.sh",
      "args": []
    }
  }
}
```

令牌由启动脚本读取 `user.json`，不要放进上面这份 JSON。

## 常见问题

<details>
<summary>我必须安装 Cursor 才能用吗？</summary>

不用。浏览器打开 [dentalbook.example.com](https://dentalbook.example.com/) 就能检索和下载。Cursor / Codex / Claude 是同一份库的 Agent 入口，不是唯一入口。
</details>

<details>
<summary>管理员和医生的网页有什么不一样？</summary>

没有两套网站。管理员和医生登录的是同一套浅色文献库，顶栏和列表布局相同。差别在权限：抓取全文等管理动作只出现在隔离的管理 MCP 里。
</details>

<details>
<summary>令牌应该放在哪里？</summary>

令牌只放在本机 `.dentalbook-local/user.json`，权限设为 `0600`。不要写入 git、`.cursor/mcp.json`、`.mcp.json` 或公开聊天记录。丢失后请联系管理员轮换，不要把旧令牌贴到 issue 里。
</details>

<details>
<summary>为什么有的论文能看题录，却下不了 PDF？</summary>

题录、中心缓存和本机文件是三种状态。有目录不等于中心已经有合法全文，中心有全文也不等于你这台电脑已经下载。页面和 MCP 会分开显示，不会把「仅题录」说成已经有 PDF。
</details>

<details>
<summary>我可以自己搭一个公开站点吗？</summary>

这个仓库服务的是受邀的小范围使用者。中心数据、令牌和 PDF 都不是公开资源。若要自建，请先读仓库里的架构、安全和部署文档，并自行负责 TLS、哈希令牌和访问控制。
</details>

<details>
<summary>它会不会自己编引用？</summary>

Dentalbook 不负责替模型消除幻觉。它只保存和核对文献资产：题录、文件指纹、以及（后续版本中）绑到同一 PDF 的原句证明。没有回执，就不能声称写入成功。
</details>

## 文档

| 你要做的事 | 去这里 |
|---|---|
| 把 MCP 接到 Cursor / Codex | [在线医生接入](https://dentalbook.example.com/docs) |
| 看产品范围 | [PRD](docs/PRD.md) |
| 看哪些工具已经能用 | [MCP 工具目录](docs/MCP_TOOL_CATALOG.md) |
| 看宿主配置示例 | [config/hosts](config/hosts/README.md) |

## 明确不做

- 不做独立 Agent、Electron 或桌面聊天壳
- 不把未实现的工具注册成「已经成功」
- 不把真实令牌、PDF 或用户数据提交进 git
- 第一版不做 PPT、全文翻译或公开社区

<details>
<summary>维护者：仓库结构与本地检查</summary>

| 目录 | 职责 |
|---|---|
| `apps/web` | 浅色 Web 主界面 |
| `packages/center-service` | 共享目录、PDF 库与浏览器会话 |
| `packages/mcp-user` | 医生侧 MCP（stdio / 本机 HTTP） |
| `packages/mcp-admin` | 隔离的管理 MCP |
| `docs` | 产品、架构、协议与验收 |

```bash
npm install
npm run check
```

部署与双机验收见 [WEB_DEPLOYMENT.md](docs/WEB_DEPLOYMENT.md) 和 [MAC_A_ACCEPTANCE.md](docs/MAC_A_ACCEPTANCE.md)。
</details>
