import { loadCenterUsers, startCenterServer } from "./server.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = process.env.DENTALBOOK_CENTER_ROOT;
const usersFile = process.env.DENTALBOOK_CENTER_USERS_FILE;
const tlsCertPath = process.env.DENTALBOOK_CENTER_TLS_CERT;
const tlsKeyPath = process.env.DENTALBOOK_CENTER_TLS_KEY;
const allowInsecureLoopback = process.env.DENTALBOOK_CENTER_ALLOW_INSECURE_LOOPBACK === "1";
const defaultWebDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/dist");

if (!rootDir) throw new Error("DENTALBOOK_CENTER_ROOT is required.");
if (!usersFile) throw new Error("DENTALBOOK_CENTER_USERS_FILE is required.");
if ((tlsCertPath && !tlsKeyPath) || (!tlsCertPath && tlsKeyPath)) throw new Error("DENTALBOOK_CENTER_TLS_CERT and DENTALBOOK_CENTER_TLS_KEY must be configured together.");
if (!tlsCertPath && !allowInsecureLoopback) throw new Error("TLS is required unless DENTALBOOK_CENTER_ALLOW_INSECURE_LOOPBACK=1 is explicitly set for a loopback-only Tunnel origin.");

const marker = await readFile(resolve(rootDir, "VERSION"), "utf8").catch(() => "");
if (marker.trim() !== "dentalbook-test-library/v1") {
  throw new Error("DENTALBOOK_CENTER_ROOT must contain the dentalbook-test-library/v1 marker; refusing an unmarked or production path.");
}

const defaultReleasesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../releases/mcp-user");

const center = await startCenterServer({
  rootDir,
  webDir: process.env.DENTALBOOK_WEB_DIR ?? defaultWebDir,
  releasesDir: process.env.DENTALBOOK_RELEASES_DIR ? resolve(process.env.DENTALBOOK_RELEASES_DIR) : defaultReleasesDir,
  users: await loadCenterUsers(usersFile),
  host: process.env.DENTALBOOK_CENTER_HOST ?? "127.0.0.1",
  port: Number(process.env.DENTALBOOK_CENTER_PORT ?? "7342"),
  tlsCertPath,
  tlsKeyPath,
  allowInsecureLoopback,
});

console.error(`Dentalbook center listening on ${center.baseUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void center.close().finally(() => process.exit(0));
  });
}
