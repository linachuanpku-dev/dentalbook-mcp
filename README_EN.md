# Dentalbook

### A private literature library for dentists — in the browser, and in Cursor, Codex, and Claude

[![Web](https://img.shields.io/badge/app-dentalbook.example.com-0F766E)](https://dentalbook.example.com/)
[![Docs](https://img.shields.io/badge/docs-user%20setup-111827)](https://dentalbook.example.com/docs)
[![MCP](https://img.shields.io/badge/MCP-Cursor%20%7C%20Codex%20%7C%20Claude-6366F1)](https://dentalbook.example.com/docs?section=cursor)
[![Node](https://img.shields.io/badge/node-22%2B-339933)](https://nodejs.org/)

### Use it here: **[dentalbook.example.com](https://dentalbook.example.com/)**

[中文](README.md) | English | [Setup docs](https://dentalbook.example.com/docs)

---

## What it is

Finding papers, keeping full text, lifting evidence, and writing reviews usually lives across browsers, shared drives, and chat windows. General-purpose agents can write, but they do not own a private library you can actually check.

**Dentalbook** puts a shared paper catalog, controlled PDFs, and a basic author index in a stable website. The same capabilities are then exposed through open MCP to Cursor, Codex, Claude, and other hosts you already use. It is not another chat app, and it does not replace your model.

The first release can already search and download in the browser, and list, upload, and sync the same papers from an agent. Notebooks, verified citations, and reviews are not registered yet and will not pretend to succeed.

## What you can do now

- **One library in the browser** — sign in, search the shared catalog, open records, download cached PDFs, and browse the basic author index
- **See the real status** — tell apart “metadata only”, “PDF on the center”, and “PDF on this computer”
- **Use the same library from an agent** — doctor-side MCP in Cursor / Codex / Claude, without a custom desktop chat shell
- **Upload from your machine** — import a PDF from a folder you explicitly allow; success only comes with a real receipt
- **Pull full text when you need it** — if the center already has a verified PDF, sync it into your own local library
- **Keep fetch on the admin side** — full-text fetch lives on the admin MCP only

## What comes next

- Local notebooks, reading state, and highlights
- Citations bound to the same PDF, page, and original sentence
- Trusted reviews and author-relationship views
- Richer token, backup, and audit tools

Medical facts and formal conclusions will still require checkable citations. Model-invented sources are not enough.

## Quick start

### 1. In the browser

1. Open **[dentalbook.example.com](https://dentalbook.example.com/)**
2. Sign in with the access token from your administrator (admin and doctor use the same site)
3. Search the library, open a record, and download a cached PDF

You do not need Cursor for search and download.

### 2. Connect Cursor / Codex / Claude

The full steps, copy-paste config, and one-shot prompt are here:

**[dentalbook.example.com/docs](https://dentalbook.example.com/docs)**

Short version:

1. Install Node.js 22+, clone this repo, then run `npm install && npm run build`
2. Ask your administrator for a **doctor-side** token (the same token used on the website)
3. Create a gitignored `.dentalbook-local/user.json` on your machine (`0600`); never commit the token
4. Cursor uses `.cursor/mcp.json` in this repo; Codex uses the repo plugin and root `.mcp.json`
5. Reload MCP, then call `system.health` and `library.stats` to confirm the center is reachable

Doctors only configure `dentalbook-user`. Do not add the admin MCP to everyday plugin config.

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

The start script reads the token from `user.json`. Do not put it in the JSON above.

## FAQ

<details>
<summary>Do I have to install Cursor?</summary>

No. Open [dentalbook.example.com](https://dentalbook.example.com/) to search and download. Cursor / Codex / Claude are another door into the same library, not the only door.
</details>

<details>
<summary>Is the admin site different from the doctor site?</summary>

There is one light-theme library. Admin and doctor logins share the same page and layout. The difference is permission: fetch and other admin actions stay on the isolated admin MCP.
</details>

<details>
<summary>Where should I put my token?</summary>

Keep it in `.dentalbook-local/user.json` on your machine, mode `0600`. Do not write it to git, `.cursor/mcp.json`, `.mcp.json`, or a public chat. If it leaks, ask an administrator to rotate it. Do not paste live tokens into issues.
</details>

<details>
<summary>Why can I see a paper but not download the PDF?</summary>

Catalog metadata, the center cache, and your local file are three different states. A record does not mean the center has a lawful PDF, and a center PDF does not mean this computer has downloaded it. The site and MCP show those states separately.
</details>

<details>
<summary>Can I stand up a public site from this repo?</summary>

This repository serves a small invited group. Center data, tokens, and PDFs are not public. If you self-host, read the architecture, security, and deployment docs first, and take responsibility for TLS, hashed tokens, and access control.
</details>

<details>
<summary>Will it invent citations for me?</summary>

Dentalbook does not claim to remove model hallucinations. It stores and checks literature assets: catalog records, file fingerprints, and (in later versions) sentence-level proof bound to the same PDF. No receipt means the write did not succeed.
</details>

## Docs

| If you want to… | Go here |
|---|---|
| Connect MCP in Cursor / Codex | [User setup](https://dentalbook.example.com/docs) |
| Read the product scope | [PRD](docs/PRD.md) |
| See which tools are actually live | [MCP tool catalog](docs/MCP_TOOL_CATALOG.md) |
| Copy host config examples | [config/hosts](config/hosts/README.md) |

## What this is not

- No standalone agent, Electron app, or desktop chat shell
- No unimplemented tool registered as a fake success
- No real tokens, PDFs, or user data in git
- No PPT, full-text translation, or public community in this release

<details>
<summary>Maintainers: layout and local check</summary>

| Path | Role |
|---|---|
| `apps/web` | Light-theme web UI |
| `packages/center-service` | Shared catalog, PDF store, browser sessions |
| `packages/mcp-user` | Doctor-side MCP (stdio / loopback HTTP) |
| `packages/mcp-admin` | Isolated admin MCP |
| `docs` | Product, architecture, protocol, acceptance |

```bash
npm install
npm run check
```

Deployment notes: [WEB_DEPLOYMENT.md](docs/WEB_DEPLOYMENT.md).
</details>
