#!/usr/bin/env node

const command = process.argv[2] ?? "help";
const baseUrl = process.env.DENTALBOOK_ADMIN_BASE_URL ?? "http://127.0.0.1:7341";

if (command === "health") {
  const response = await fetch(`${baseUrl}/healthz`);
  if (!response.ok) throw new Error(`Health request failed: HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
} else if (["backup", "restore", "reindex", "token"].includes(command)) {
  console.error(JSON.stringify({ ok: false, errorCode: "not_implemented", command, message: "Command reserved by the v5 scaffold; no state was changed." }));
  process.exitCode = 2;
} else {
  console.log("Usage: dentalbook-admin health | backup | restore | reindex | token");
  console.log("Only health is implemented in this scaffold. Reserved commands exit with code 2 and never report success.");
}
