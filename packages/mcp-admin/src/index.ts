import express from "express";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDentalbookAdminServer } from "./server.js";
import { AdminCenterClient } from "./center-client.js";

function centerClient() {
  const centerUrl = process.env.DENTALBOOK_ADMIN_CENTER_URL;
  const centerBearer = process.env.DENTALBOOK_ADMIN_CENTER_BEARER;
  if (!centerUrl || !centerBearer) {
    throw new Error("DENTALBOOK_ADMIN_CENTER_URL and DENTALBOOK_ADMIN_CENTER_BEARER are required.");
  }
  return new AdminCenterClient({ apiBaseUrl: centerUrl.replace(/\/$/u, ""), bearerToken: centerBearer, requestTimeoutMs: 10_000 });
}

async function startHttp(center: AdminCenterClient) {
  const host = process.env.DENTALBOOK_ADMIN_HOST ?? "127.0.0.1";
  const port = Number(process.env.DENTALBOOK_ADMIN_PORT ?? "7341");
  const token = process.env.DENTALBOOK_ADMIN_TOKEN;
  if (!token) throw new Error("DENTALBOOK_ADMIN_TOKEN is required to start the admin MCP over HTTP.");

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.get("/healthz", async (_request, response) => response.json({ ok: true, service: "dentalbook-admin", businessReady: await center.health() }));
  app.use("/mcp", (request, response, next) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  app.post("/mcp", async (request, response) => {
    const server = createDentalbookAdminServer(center);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    response.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });

  app.listen(port, host, () => {
    console.error(`Dentalbook admin MCP listening on http://${host}:${port}/mcp`);
  });
}

const transport = process.env.DENTALBOOK_ADMIN_MCP_TRANSPORT ?? "http";
const center = centerClient();

if (transport === "http") {
  await startHttp(center);
} else if (transport === "stdio") {
  const server = createDentalbookAdminServer(center);
  await server.connect(new StdioServerTransport());
} else {
  throw new Error("DENTALBOOK_ADMIN_MCP_TRANSPORT must be stdio or http.");
}
