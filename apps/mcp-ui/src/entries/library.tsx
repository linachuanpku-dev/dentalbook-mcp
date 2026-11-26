import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShell, dentalbookStyles, EmptyState, PaperSourceLinks, StatusPill } from "@dentalbook/ui-kit";
import { callTool } from "../bridge.js";

type PdfStatus = "local" | "central_cached" | "metadata_only" | "missing";
type PaperUpload = { role: "admin" | "user"; uploadedBy: string; uploadedAt: string; channel: "admin_fetch" | "user_import" };
type PaperPdfVersion = {
  sha256: string;
  byteSize: number;
  pageCount: number;
  mimeVerified: boolean;
  verifiedAt: string;
  pdfUpload?: PaperUpload;
};
type PaperItem = {
  paper: { paperId: string; doi: string; title: string; keywords?: string[]; keywordsStatus?: "hit" | "empty" | "none" };
  pdfProof: { status: PdfStatus; fileSha256?: string; byteSize?: number; mimeVerified: boolean };
  pdfs?: PaperPdfVersion[];
  metadataUpload?: PaperUpload;
  pdfUpload?: PaperUpload;
};
type LibraryData = {
  ok: boolean;
  message: string;
  items?: PaperItem[];
  total?: number;
  stats?: { sharedPapers: number; sharedPdfs: number; metadataOnly: number; localPdfs: number };
};

function structured(value: unknown): LibraryData {
  if (!value || typeof value !== "object") return { ok: false, message: "宿主没有返回结构化结果。" };
  const record = value as Record<string, unknown>;
  const content = record.structuredContent && typeof record.structuredContent === "object" ? record.structuredContent : record;
  return content as LibraryData;
}

function PaperKeywords({ paper }: { paper: PaperItem["paper"] }) {
  const status = paper.keywordsStatus ?? "none";
  const terms = paper.keywords ?? [];
  if (status === "hit" && terms.length) {
    return (
      <div className="db-row">
        {terms.map((term) => <StatusPill key={term} tone="ok">{term}</StatusPill>)}
      </div>
    );
  }
  if (status === "empty") return <p>keywords · 没抓到</p>;
  return <p>keywords · 没尝试过</p>;
}

function statusLabel(status: PdfStatus) {
  if (status === "local") return "本机已有";
  if (status === "central_cached") return "共享库可下载";
  if (status === "metadata_only") return "仅题录";
  return "全文缺失";
}

function uploadChannelLabel(channel?: "admin_fetch" | "user_import") {
  if (channel === "admin_fetch") return "admin fetch";
  if (channel === "user_import") return "用户本地上传";
  return "未知渠道";
}

function uploadStepLine(label: string, upload?: PaperUpload) {
  if (!upload) return `${label} · 尚无`;
  const stamp = new Date(upload.uploadedAt);
  const when = Number.isNaN(stamp.getTime()) ? upload.uploadedAt : stamp.toLocaleString("zh-CN", { hour12: false });
  return `${label} · ${upload.role} · ${upload.uploadedBy} · ${when} · ${uploadChannelLabel(upload.channel)}`;
}

function byteLabel(value?: number) {
  if (!value) return "";
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
}

function shaShort(sha256: string) {
  return `${sha256.slice(0, 8)}…${sha256.slice(-8)}`;
}

function paperPdfVersions(item: PaperItem): PaperPdfVersion[] {
  if (item.pdfs?.length) return item.pdfs;
  if (item.pdfProof.status !== "metadata_only" && item.pdfProof.status !== "missing" && item.pdfProof.fileSha256) {
    return [{
      sha256: item.pdfProof.fileSha256,
      byteSize: item.pdfProof.byteSize ?? 0,
      pageCount: 0,
      mimeVerified: item.pdfProof.mimeVerified,
      verifiedAt: "",
      ...(item.pdfUpload ? { pdfUpload: item.pdfUpload } : {}),
    }];
  }
  return [];
}

function LibraryApp() {
  const [data, setData] = useState<LibraryData>(() => structured(window.openai?.toolOutput));
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string>();
  const [notice, setNotice] = useState("");

  async function refresh(nextQuery = query) {
    setLoading(true);
    try {
      const result = structured(await callTool("papers.list", { query: nextQuery, limit: 50, offset: 0 }));
      setData(result);
      if (!result.ok) setNotice(result.message);
    } catch (error) {
      setNotice(`共享文献库加载失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function download(item: PaperItem, sha256?: string) {
    const key = sha256 ? `${item.paper.paperId}:${sha256}` : item.paper.paperId;
    setDownloading(key);
    setNotice("");
    try {
      const result = structured(await callTool("sync.pull_pdf", { paperId: item.paper.paperId, ...(sha256 ? { sha256 } : {}) }));
      if (!result.ok) throw new Error(result.message);
      setNotice(`《${item.paper.title}》已下载并校验。`);
      await refresh(query);
    } catch (error) {
      setNotice(`下载失败：${String(error)}`);
    } finally {
      setDownloading(undefined);
    }
  }

  useEffect(() => { void refresh(""); }, []);
  const items = useMemo(() => data.items ?? [], [data.items]);

  return (
    <AppShell kicker="Dentalbook library" title="共享文献库">
      <p className="db-copy">Mac A 与 Mac B 查看同一共享目录；“本机已有”只代表当前这台电脑。</p>
      <div className="db-stats" aria-label="文献库统计">
        <div><strong>{data.stats?.sharedPapers ?? "—"}</strong><span>共享题录</span></div>
        <div><strong>{data.stats?.sharedPdfs ?? "—"}</strong><span>可下载 PDF</span></div>
        <div><strong>{data.stats?.metadataOnly ?? "—"}</strong><span>仅题录</span></div>
        <div><strong>{data.stats?.localPdfs ?? "—"}</strong><span>本机已有</span></div>
      </div>
      <form className="db-search" onSubmit={(event) => { event.preventDefault(); void refresh(query); }}>
        <input aria-label="搜索共享文献" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按标题、DOI 或 paperId 搜索" />
        <button className="db-button" disabled={loading}>{loading ? "刷新中…" : "搜索 / 刷新"}</button>
      </form>
      {notice ? <div className="db-result" role="status">{notice}</div> : null}
      <div className="db-library-list">
        {!loading && items.length === 0 ? <EmptyState message="当前筛选没有文献。" /> : null}
        {items.map((item) => {
          const versions = paperPdfVersions(item);
          const downloadable = versions.length > 0;
          const local = item.pdfProof.status === "local";
          return (
            <article className="db-paper" key={item.paper.paperId}>
              <div className="db-paper-main">
                <h2>{item.paper.title}</h2>
                <p>{item.paper.doi}</p>
                <PaperSourceLinks doi={item.paper.doi} />
                <div className="db-row">
                  <StatusPill tone={local || downloadable ? "ok" : "warn"}>{statusLabel(item.pdfProof.status)}</StatusPill>
                  {versions.length > 1 ? <StatusPill>{versions.length} 个 PDF 版本</StatusPill> : null}
                  {item.pdfProof.mimeVerified ? <StatusPill>PDF 已校验</StatusPill> : null}
                  {versions.length === 1 && versions[0] ? <StatusPill>{byteLabel(versions[0].byteSize)}</StatusPill> : null}
                </div>
                <PaperKeywords paper={item.paper} />
                <p>
                  {uploadStepLine("元信息上传", item.metadataUpload)}
                  {versions.length <= 1 ? <><br />{uploadStepLine("PDF 上传", item.pdfUpload)}</> : null}
                </p>
                {versions.length > 1 ? <ul className="db-pdf-versions">
                  {versions.map((version) => {
                    const key = `${item.paper.paperId}:${version.sha256}`;
                    return <li key={version.sha256}>
                      <span>{byteLabel(version.byteSize)} · {shaShort(version.sha256)}</span>
                      {version.pdfUpload ? <span>{uploadStepLine("PDF 上传", version.pdfUpload)}</span> : null}
                      <button
                        className="db-button"
                        disabled={downloading === key}
                        onClick={() => { void download(item, version.sha256); }}
                      >
                        {downloading === key ? "下载中…" : "下载"}
                      </button>
                    </li>;
                  })}
                </ul> : null}
              </div>
              {versions.length <= 1 ? <div className="db-paper-action">
                <button
                  className="db-button"
                  disabled={!downloadable || downloading === item.paper.paperId}
                  onClick={() => { void download(item, versions[0]?.sha256); }}
                >
                  {local ? "已下载" : downloading === item.paper.paperId ? "下载中…" : downloadable ? "下载" : "不可下载"}
                </button>
              </div> : null}
            </article>
          );
        })}
      </div>
    </AppShell>
  );
}

const style = document.createElement("style");
style.textContent = `${dentalbookStyles}
.db-pdf-versions { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px; }
.db-pdf-versions li { display: grid; gap: 4px; padding: 10px; border: 1px solid #d8e3de; border-radius: 10px; background: #f8fbf9; font-size: 12px; color: #718079; }
.db-pdf-versions .db-button { justify-self: start; }
`;
document.head.append(style);
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<StrictMode><LibraryApp /></StrictMode>);
