import { useEffect, useState } from "react";

export const DOC_SECTIONS = [
  { id: "getting-started", label: "快速开始" },
  { id: "prompt", label: "三条 Prompt" },
  { id: "upgrade", label: "升级 MCP" },
  { id: "workbuddy", label: "WorkBuddy" },
  { id: "trae", label: "Trae" },
  { id: "qoder", label: "Qoder" },
  { id: "cursor", label: "Cursor（开发者）" },
] as const;

export type DocSectionId = (typeof DOC_SECTIONS)[number]["id"];

export const SETUP_PROMPT = `请配置 Dentalbook user MCP。不要 admin，不要 clone GitHub。令牌：<TOKEN>

1) npmmirror 装 Node 22（终端原样执行）：
ARCH=$(uname -m); case "$ARCH" in arm64) A=arm64;; *) A=x64;; esac
VER=$(curl -fsSL https://npmmirror.com/mirrors/node/latest-v22.x/ | sed -n 's/.*"version":"\\(v[^"]*\\)".*/\\1/p' | head -1)
curl -fsSL "https://npmmirror.com/mirrors/node/\${VER}/node-\${VER}-darwin-\${A}.pkg" -o /tmp/dentalbook-node.pkg
sudo installer -pkg /tmp/dentalbook-node.pkg -target /
export PATH="/usr/local/bin:$PATH" && node -v

2) 装 MCP + 自识别 IDE：
curl -fsSL https://dentalbook.example.com/install/mcp-user.sh | bash -s -- --write-auto --skip-node --token '<TOKEN>' --local-data-dir "$HOME/Library/Application Support/Dentalbook/me" --import-root "$HOME/Downloads"
→ 提醒我重载 MCP；调 system.health / library.stats

3) 验收：papers.list 取 10 篇有中心 PDF 的 → sync.pull_pdf → 复制到 ~/Desktop 并列文件名`;

export const UPGRADE_COMMAND = `curl -fsSL https://dentalbook.example.com/install/mcp-user.sh | bash -s -- --write-auto --skip-node --upgrade --local-data-dir "$HOME/Library/Application Support/Dentalbook/me"`;

const HOST_MCP_EXAMPLE = `{
  "mcpServers": {
    "dentalbook-user": {
      "command": "/usr/local/bin/node",
      "args": ["$HOME/.dentalbook/mcp-user/current/dist/index.js"],
      "env": {
        "DENTALBOOK_USER_CONFIG": "$HOME/.dentalbook/user.json",
        "DENTALBOOK_MCP_UI_DIR": "$HOME/.dentalbook/mcp-user/current/mcp-ui",
        "DENTALBOOK_MCP_VERSION": "0.1.0"
      }
    }
  }
}`;

const CURSOR_MCP_EXAMPLE = `{
  "mcpServers": {
    "dentalbook-user": {
      "command": "./scripts/start-user-mcp.sh",
      "args": []
    }
  }
}`;

export function parseDocSection(value: string | null): DocSectionId {
  if (value === "upgrade") return "upgrade";
  return DOC_SECTIONS.some((section) => section.id === value) ? value as DocSectionId : "getting-started";
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const ok = await copyText(value);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <div className="docs-code">
      <div className="docs-code-bar">
        <span>{label}</span>
        <button type="button" className="web-button quiet" onClick={() => { void copy(); }}>{copied ? "已复制" : "复制"}</button>
      </div>
      <pre><code>{value}</code></pre>
    </div>
  );
}

export function DocsView({ section, onSection }: { section: DocSectionId; onSection: (id: DocSectionId) => void }) {
  useEffect(() => {
    document.getElementById(`docs-${section}`)?.scrollIntoView({ block: "start" });
  }, [section]);

  return (
    <div className="docs-layout">
      <aside className="docs-side" aria-label="文档目录">
        <p className="docs-side-kicker">Docs</p>
        <p className="docs-side-title">医生接入</p>
        <nav className="docs-toc">
          {DOC_SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => onSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <article className="docs-article">
        <p className="web-eyebrow">User MCP</p>
        <h1>同域安装 Dentalbook MCP</h1>
        <p className="docs-lead">医生侧从 <code>dentalbook.example.com</code> 下载预构建 MCP，无需 GitHub 或仓库 <code>npm install</code>。令牌只写入本机 <code>~/.dentalbook/user.json</code>（权限 0600），不写进 MCP 配置或聊天记录。</p>

        <section id="docs-getting-started" className="docs-section">
          <h2>快速开始</h2>
          <ol>
            <li>取得 user 访问令牌（与 Web 登录相同）。</li>
            <li>在 WorkBuddy / Trae / Qoder 等 Agent 终端粘贴下方「三条 Prompt」；或手动执行 install 脚本。</li>
            <li>重载 MCP 后调用 <code>system.health</code> 与 <code>library.stats</code> 验收。</li>
          </ol>
          <p>安装产物位于 <code>~/.dentalbook/mcp-user/&lt;version&gt;/</code>，<code>current</code> 为当前版本符号链接。<code>--write-auto</code> 或 <code>--ide</code> 会把宿主名写入本机 <code>user.json</code>，中心只记用过哪个 Agent。</p>
        </section>

        <section id="docs-prompt" className="docs-section">
          <h2>三条 Prompt</h2>
          <p>复制后发给 Agent。把 <code>&lt;TOKEN&gt;</code> 换成你的访问令牌（单独提供，不要写进仓库）。</p>
          <CopyBlock label="WorkBuddy / Trae / Qoder prompt" value={SETUP_PROMPT} />
        </section>

        <section id="docs-upgrade" className="docs-section">
          <h2>升级 MCP</h2>
          <p>中心或 Web 单独更新时无需动本机 MCP（L0）。MCP 有 bug 修复或新只读工具时建议升级（L1）；<code>system.health</code> 会返回 <code>upgradeRecommended</code>。新写工具、协议不兼容或安全修复时必须升级（L2）；Web 登录后会显示横幅。</p>
          <p>令牌已在 <code>~/.dentalbook/user.json</code> 中，升级时无需再传 <code>--token</code>：</p>
          <CopyBlock label="升级命令" value={UPGRADE_COMMAND} />
          <p>升级后重载 MCP，再调 <code>system.health</code> 确认 <code>localMcpVersion</code> 与 <code>latestMcpVersion</code> 一致。</p>
        </section>

        <section id="docs-workbuddy" className="docs-section">
          <h2>WorkBuddy</h2>
          <p>推荐用 install 脚本的 <code>--write-auto</code> 自动写入 <code>~/.workbuddy/mcp.json</code>。手动配置示例：</p>
          <CopyBlock label="~/.workbuddy/mcp.json" value={HOST_MCP_EXAMPLE} />
        </section>

        <section id="docs-trae" className="docs-section">
          <h2>Trae</h2>
          <p><code>--write-auto</code> 写入 <code>~/Library/Application Support/Trae/User/mcp.json</code>。手动示例同上，路径改为 Trae 配置目录。</p>
          <CopyBlock label="Trae mcp.json" value={HOST_MCP_EXAMPLE} />
        </section>

        <section id="docs-qoder" className="docs-section">
          <h2>Qoder</h2>
          <p><code>--write-auto</code> 写入 <code>~/.qoder/mcp.json</code>。手动示例：</p>
          <CopyBlock label="~/.qoder/mcp.json" value={HOST_MCP_EXAMPLE} />
        </section>

        <section id="docs-cursor" className="docs-section">
          <h2>Cursor（开发者）</h2>
          <p>建设者仍在仓库内开发时，可继续用项目 <code>.cursor/mcp.json</code> 与 <code>scripts/start-user-mcp.sh</code>：</p>
          <CopyBlock label=".cursor/mcp.json" value={CURSOR_MCP_EXAMPLE} />
        </section>
      </article>
    </div>
  );
}
