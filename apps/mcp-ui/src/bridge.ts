declare global {
  interface Window {
    openai?: {
      toolOutput?: unknown;
      callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
      requestDisplayMode?: (options: { mode: "fullscreen" | "inline" }) => Promise<unknown>;
    };
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };
const pending = new Map<number, Pending>();
let nextId = 1;

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data as { jsonrpc?: string; id?: number; result?: unknown; error?: unknown };
  if (message?.jsonrpc !== "2.0" || message.id === undefined) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(message.error);
  else request.resolve(message.result);
});

export function callTool(name: string, args: Record<string, unknown> = {}) {
  const id = nextId++;
  window.parent.postMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, "*");
  return new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
}

export async function requestFullscreen(): Promise<"requested" | "unsupported"> {
  if (!window.openai?.requestDisplayMode) return "unsupported";
  await window.openai.requestDisplayMode({ mode: "fullscreen" });
  return "requested";
}
