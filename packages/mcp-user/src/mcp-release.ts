export type McpReleaseManifest = {
  version: string;
  sha256: string;
  publishedAt?: string;
  upgradeRecommended?: boolean;
  upgradeRequired?: boolean;
  minCenterVersion?: string;
  notes?: string;
  upgradeHint?: string;
  upgradeUrl?: string;
};

export function localMcpVersion() {
  return process.env.DENTALBOOK_MCP_VERSION?.trim() || process.env.DENTALBOOK_VERSION?.trim() || "unknown";
}

export async function fetchMcpReleaseManifest(apiBaseUrl: string, timeoutMs = 5000): Promise<McpReleaseManifest | undefined> {
  try {
    const response = await fetch(`${apiBaseUrl.replace(/\/+$/u, "")}/releases/mcp-user/manifest.json`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    return await response.json() as McpReleaseManifest;
  } catch {
    return undefined;
  }
}

export function mcpUpgradeStatus(localVersion: string, manifest?: McpReleaseManifest) {
  if (!manifest?.version || localVersion === "unknown") {
    return {
      latestMcpVersion: manifest?.version,
      upgradeRecommended: false,
      upgradeRequired: false,
      upgradeHint: undefined as string | undefined,
    };
  }
  const outdated = localVersion !== manifest.version;
  const upgradeRecommended = outdated && manifest.upgradeRecommended === true;
  const upgradeRequired = outdated && manifest.upgradeRequired === true;
  const upgradeHint = (upgradeRecommended || upgradeRequired) && typeof manifest.upgradeHint === "string" && manifest.upgradeHint.trim()
    ? manifest.upgradeHint.trim()
    : undefined;
  return {
    latestMcpVersion: manifest.version,
    upgradeRecommended,
    upgradeRequired,
    upgradeHint,
  };
}
