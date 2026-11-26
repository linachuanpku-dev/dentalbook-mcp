import type { PropsWithChildren, ReactNode } from "react";

export const dentalbookStyles = `
  :root {
    color-scheme: light;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --db-bg: #f5f7f5;
    --db-surface: rgba(255, 255, 255, 0.92);
    --db-text: #17211f;
    --db-muted: #61706c;
    --db-line: #d7e0dc;
    --db-accent: #0f766e;
    --db-accent-soft: #dff3ef;
    --db-warn: #9a6700;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: transparent; color: var(--db-text); }
  button { font: inherit; }
  .db-shell { min-height: 100vh; padding: 14px; background: linear-gradient(145deg, var(--db-bg), transparent); }
  .db-card { border: 1px solid var(--db-line); border-radius: 16px; background: var(--db-surface); padding: 18px; box-shadow: 0 10px 30px rgba(15, 40, 34, .08); }
  .db-kicker { color: var(--db-accent); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .db-title { margin: 6px 0 4px; font-size: 20px; line-height: 1.2; }
  .db-copy { margin: 0; color: var(--db-muted); font-size: 14px; line-height: 1.55; }
  .db-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
  .db-pill { border: 1px solid var(--db-line); border-radius: 999px; padding: 5px 9px; color: var(--db-muted); font-size: 12px; }
  .db-pill[data-tone="ok"] { border-color: var(--db-accent); background: var(--db-accent-soft); color: var(--db-accent); }
  .db-pill[data-tone="warn"] { color: var(--db-warn); }
  .db-button { border: 1px solid var(--db-accent); border-radius: 10px; background: var(--db-accent); color: #fff; cursor: pointer; padding: 8px 11px; }
  .db-button[data-kind="secondary"] { background: transparent; color: var(--db-accent); }
  .db-button:disabled { cursor: not-allowed; opacity: .55; }
  .db-result { margin-top: 12px; padding: 10px; border-radius: 10px; background: var(--db-accent-soft); color: var(--db-muted); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
  .db-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }
  .db-stats > div { border: 1px solid var(--db-line); border-radius: 12px; background: #fff; padding: 10px; }
  .db-stats strong { display: block; color: var(--db-text); font-size: 20px; }
  .db-stats span { color: var(--db-muted); font-size: 12px; }
  .db-search { display: flex; gap: 8px; margin-top: 14px; }
  .db-search input { min-width: 0; flex: 1; border: 1px solid var(--db-line); border-radius: 10px; background: #fff; color: var(--db-text); padding: 9px 11px; font: inherit; }
  .db-search input:focus { outline: 2px solid var(--db-accent-soft); border-color: var(--db-accent); }
  .db-library-list { display: grid; gap: 9px; margin-top: 14px; }
  .db-paper { display: flex; align-items: center; justify-content: space-between; gap: 14px; border: 1px solid var(--db-line); border-radius: 13px; background: #fff; padding: 13px; }
  .db-paper-main { min-width: 0; }
  .db-paper h2 { margin: 0; color: var(--db-text); font-size: 15px; line-height: 1.35; }
  .db-paper p { margin: 5px 0 0; overflow-wrap: anywhere; color: var(--db-muted); font-size: 12px; }
  .db-paper-links { display: flex; flex-wrap: wrap; gap: 12px; margin: 6px 0 0; font-size: 12px; font-weight: 700; }
  .db-paper-links a { color: var(--db-accent); text-decoration: none; }
  .db-paper-links a:hover, .db-paper-links a:focus-visible { text-decoration: underline; }
  .db-paper-action { flex: 0 0 auto; }
  @media (max-width: 620px) {
    .db-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .db-paper { align-items: stretch; flex-direction: column; }
    .db-paper-action .db-button { width: 100%; }
  }
`;

export function AppShell({ kicker, title, children }: PropsWithChildren<{ kicker: string; title: string }>) {
  return (
    <main className="db-shell">
      <section className="db-card">
        <div className="db-kicker">{kicker}</div>
        <h1 className="db-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" }) {
  return <span className="db-pill" data-tone={tone}>{children}</span>;
}

export function paperSourceLinks(doi: string) {
  const value = doi.trim().replace(/^doi:\s*/iu, "");
  if (!value) return undefined;
  return { publisherUrl: `https://doi.org/${encodeURI(value)}` };
}

export function PaperSourceLinks({ doi }: { doi: string }) {
  const links = paperSourceLinks(doi);
  if (!links) return null;
  return (
    <p className="db-paper-links">
      <a href={links.publisherUrl} target="_blank" rel="noopener noreferrer">原文链接</a>
    </p>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="db-copy">{message}</p>;
}
