import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const MCP_HOSTS = ["workbuddy", "trae", "cursor", "codex", "claude", "qoder"] as const;

export type UserConfig = {
  apiBaseUrl: string;
  bearerToken: string;
  localDataDir: string;
  requestTimeoutMs: number;
  maxPdfBytes: number;
  allowInsecureLoopback: boolean;
  importRoots: string[];
  mcpHost?: (typeof MCP_HOSTS)[number];
};

type RawUserConfig = Partial<UserConfig>;

export async function loadUserConfig(path = process.env.DENTALBOOK_USER_CONFIG ?? resolve(process.cwd(), ".dentalbook-local/user.json")): Promise<UserConfig | undefined> {
  let text: string;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const raw = JSON.parse(text) as RawUserConfig & { host?: string };
  if (typeof raw.apiBaseUrl !== "string" || typeof raw.bearerToken !== "string" || typeof raw.localDataDir !== "string") {
    throw new Error("Dentalbook user config requires apiBaseUrl, bearerToken, and localDataDir.");
  }
  if (!isAbsolute(raw.localDataDir)) throw new Error("Dentalbook localDataDir must be an absolute path.");
  const importRoots = raw.importRoots ?? [];
  if (!Array.isArray(importRoots) || importRoots.some((root) => typeof root !== "string" || !isAbsolute(root))) {
    throw new Error("Dentalbook importRoots must contain only absolute paths.");
  }
  const url = new URL(raw.apiBaseUrl);
  const allowInsecureLoopback = raw.allowInsecureLoopback === true;
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:")) {
    throw new Error("Dentalbook center requires HTTPS; insecure HTTP is allowed only for explicit loopback tests.");
  }
  if (raw.bearerToken.length < 12) throw new Error("Dentalbook bearerToken is missing or too short.");
  const hostRaw = (process.env.DENTALBOOK_MCP_HOST ?? raw.host ?? raw.mcpHost ?? "").trim().toLowerCase();
  const mcpHost = (MCP_HOSTS as readonly string[]).includes(hostRaw) ? hostRaw as UserConfig["mcpHost"] : undefined;
  return {
    apiBaseUrl: url.toString().replace(/\/$/u, ""),
    bearerToken: raw.bearerToken,
    localDataDir: resolve(raw.localDataDir),
    requestTimeoutMs: raw.requestTimeoutMs ?? 10_000,
    maxPdfBytes: raw.maxPdfBytes ?? 100 * 1024 * 1024,
    allowInsecureLoopback,
    importRoots: importRoots.map((root) => resolve(root)),
    ...(mcpHost ? { mcpHost } : {}),
  };
}
