import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadUserConfig } from "./config.js";
import { createDentalbookUserServer, type UserApplicationPort } from "./server.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export type UserHttpMcpOptions = {
  application?: UserApplicationPort;
  bearerToken?: string;
  host?: string;
  port?: number;
};

type Session = { mcpServer: McpServer; transport: StreamableHTTPServerTransport };

function equalSecret(left: string, right: string) {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) throw new Error("The MCP request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

export async function startUserMcpHttp(options: UserHttpMcpOptions = {}) {
  const config = options.bearerToken ? undefined : await loadUserConfig();
  const bearerToken = options.bearerToken ?? config?.bearerToken;
  if (!bearerToken) throw new Error("A Bearer token is required to start the user Streamable HTTP MCP.");

  const host = options.host ?? process.env.DENTALBOOK_USER_MCP_HOST ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new Error("User Streamable HTTP MCP must bind loopback until TLS is configured.");
  const port = options.port ?? Number(process.env.DENTALBOOK_USER_MCP_PORT ?? "7340");
  const sessions = new Map<string, Session>();

  async function sessionFor(request: IncomingMessage) {
    const existingId = request.headers["mcp-session-id"];
    if (typeof existingId === "string" && sessions.has(existingId)) return sessions.get(existingId)!;
    const mcpServer = await createDentalbookUserServer(options.application ? { application: options.application } : {});
    const session: Session = { mcpServer, transport: undefined as unknown as StreamableHTTPServerTransport };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
        void session.mcpServer.close();
      },
    });
    await mcpServer.connect(session.transport as never);
    return session;
  }

  const httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://dentalbook.local");
      if (request.method === "GET" && url.pathname === "/healthz") {
        const application = options.application;
        const centerReachable = application ? await application.health() : Boolean(config);
        sendJson(response, 200, { ok: true, service: "dentalbook-user", businessReady: Boolean(application) && centerReachable });
        return;
      }
      if (url.pathname !== "/mcp") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer ") || !equalSecret(authorization.slice("Bearer ".length), bearerToken)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const session = await sessionFor(request);
      const body = request.method === "POST" ? await readJson(request) : undefined;
      await session.transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
      else response.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  return {
    httpServer,
    host: address.address,
    port: address.port,
    baseUrl: `http://${address.address}:${address.port}`,
    async close() {
      await Promise.all([...sessions.values()].map(async (session) => {
        await session.transport.close();
        await session.mcpServer.close();
      }));
      sessions.clear();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
