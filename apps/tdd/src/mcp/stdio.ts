import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTddMcpServer } from "./server.js";

const server = createTddMcpServer({ artifactRoot: process.cwd() });
await server.connect(new StdioServerTransport());
