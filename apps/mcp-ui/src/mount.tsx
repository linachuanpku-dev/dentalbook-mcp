import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShell, dentalbookStyles, EmptyState, StatusPill } from "@dentalbook/ui-kit";
import { callTool, requestFullscreen } from "./bridge.js";

export type ScaffoldConfig = {
  kicker: string;
  title: string;
  description: string;
  resourceUri: string;
  probe?: boolean;
};

function ScaffoldApp({ config }: { config: ScaffoldConfig }) {
  const [result, setResult] = useState("尚未执行兼容性检查。");
  const [busy, setBusy] = useState(false);

  async function checkToolsCall() {
    setBusy(true);
    try {
      const response = await callTool("system.health");
      setResult(`tools/call 成功\n${JSON.stringify(response, null, 2)}`);
    } catch (error) {
      setResult(`tools/call 未完成：${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function expand() {
    try {
      const state = await requestFullscreen();
      setResult(state === "requested" ? "已向宿主请求全屏。" : "当前宿主没有公开全屏增强，继续使用内联视图。");
    } catch (error) {
      setResult(`宿主拒绝全屏请求，继续内联显示：${String(error)}`);
    }
  }

  return (
    <AppShell kicker={config.kicker} title={config.title}>
      <EmptyState message={config.description} />
      <div className="db-row">
        <StatusPill tone="ok">MCP Apps resource</StatusPill>
        <StatusPill>{config.resourceUri}</StatusPill>
        <StatusPill tone="warn">Scaffold only</StatusPill>
      </div>
      <div className="db-row">
        {config.probe ? <button className="db-button" disabled={busy} onClick={checkToolsCall}>{busy ? "检查中…" : "测试 tools/call"}</button> : null}
        <button className="db-button" data-kind="secondary" onClick={expand}>请求全屏</button>
      </div>
      {config.probe ? <div className="db-result">{result}</div> : null}
    </AppShell>
  );
}

export function mountScaffold(config: ScaffoldConfig) {
  const style = document.createElement("style");
  style.textContent = dentalbookStyles;
  document.head.append(style);
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root");
  createRoot(root).render(<StrictMode><ScaffoldApp config={config} /></StrictMode>);
}
