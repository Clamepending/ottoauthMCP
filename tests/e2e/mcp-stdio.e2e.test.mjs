import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockOttoauth } from "../helpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

describe("MCP stdio end-to-end", () => {
  it("discovers endpoint tools and proxies calls", async () => {
    const mock = await startMockOttoauth();
    const transport = new StdioClientTransport({
      command: "node",
      args: ["src/index.mjs"],
      cwd: repoRoot,
      env: {
        ...process.env,
        OTTOAUTH_BASE_URL: mock.baseUrl,
        OTTOAUTH_WEBHOOK_PORT: "0",
        WEBHOOK_EVENT_STORE_PATH: `/tmp/ottoauthmcp-test-${Date.now()}-1.json`,
      },
      stderr: "pipe",
    });

    const client = new Client({ name: "ottoauthmcp-tests", version: "0.1.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);

      expect(names).toContain("ottoauth_http_request");
      expect(names).toContain("ottoauth_amazon_post_services_amazon_buy");
      expect(names).toContain("ottoauth_amazon_post_services_amazon_history");
      expect(names).toContain("ottoauth_computeruse_post_computeruse_runs_run_id_events");

      const call1 = await client.callTool({
        name: "ottoauth_amazon_post_services_amazon_buy",
        arguments: {
          body: { username: "agent", private_key: "k", item_url: "x", shipping_location: "y" },
        },
      });
      expect(call1.isError).toBeFalsy();
      expect(call1.structuredContent.status).toBe(200);
      expect(call1.structuredContent.body.endpoint).toBe("buy");

      const call2 = await client.callTool({
        name: "ottoauth_computeruse_post_computeruse_runs_run_id_events",
        arguments: {
          path_params: { run_id: "run-123" },
          body: { username: "agent", private_key: "k", limit: 5 },
        },
      });
      expect(call2.structuredContent.status).toBe(200);
      expect(call2.structuredContent.body.endpoint).toBe("events");

      const call3 = await client.callTool({
        name: "ottoauth_http_request",
        arguments: {
          method: "POST",
          path: "/api/services/amazon/history",
          body: { username: "agent", private_key: "k" },
        },
      });
      expect(call3.structuredContent.status).toBe(200);
      expect(call3.structuredContent.body.endpoint).toBe("history");
    } finally {
      await client.close();
      await mock.close();
    }
  });

  it("returns tool error payloads for HTTP failures", async () => {
    const mock = await startMockOttoauth({
      handlers: {
        "POST /api/services/amazon/buy": () => ({ __status: 400, body: { error: "bad request" } }),
      },
    });

    const transport = new StdioClientTransport({
      command: "node",
      args: ["src/index.mjs"],
      cwd: repoRoot,
      env: {
        ...process.env,
        OTTOAUTH_BASE_URL: mock.baseUrl,
        OTTOAUTH_WEBHOOK_PORT: "0",
        WEBHOOK_EVENT_STORE_PATH: `/tmp/ottoauthmcp-test-${Date.now()}-2.json`,
      },
    });

    const client = new Client({ name: "ottoauthmcp-tests", version: "0.1.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const out = await client.callTool({
        name: "ottoauth_amazon_post_services_amazon_buy",
        arguments: { body: { x: 1 } },
      });
      expect(out.isError).toBe(true);
      expect(out.structuredContent.status).toBe(400);
      expect(out.structuredContent.body.error).toBe("bad request");
    } finally {
      await client.close();
      await mock.close();
    }
  });
});
