#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOttoauthMcpServer } from "./server.mjs";

async function main() {
  const app = createOttoauthMcpServer();
  await app.start();

  const transport = new StdioServerTransport();
  await app.server.connect(transport);
}

main().catch((error) => {
  console.error("[ottoauth-mcp] fatal error:", error);
  process.exit(1);
});
