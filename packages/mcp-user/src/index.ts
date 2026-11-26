import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startUserMcpHttp } from "./http.js";
import { createDentalbookUserServer } from "./server.js";

const transport = process.env.DENTALBOOK_USER_MCP_TRANSPORT ?? "stdio";

if (transport === "http") {
  const started = await startUserMcpHttp();
  console.error(`Dentalbook user MCP listening on ${started.baseUrl}/mcp`);
} else if (transport === "stdio") {
  const server = await createDentalbookUserServer();
  await server.connect(new StdioServerTransport());
} else {
  throw new Error("DENTALBOOK_USER_MCP_TRANSPORT must be stdio or http.");
}
