#!/usr/bin/env node

import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = Number(process.env.PORT || process.env.MCP_HTTP_PORT || "8004");
const HOST = String(process.env.MCP_HTTP_HOST || "0.0.0.0");
const MCP_COMMAND = String(process.env.OTTOAUTH_MCP_COMMAND || "node").trim();
const MCP_ARGS = String(process.env.OTTOAUTH_MCP_ARGS || "src/index.mjs")
  .split(/\s+/g)
  .map((x) => x.trim())
  .filter(Boolean);
const MCP_CWD = String(process.env.OTTOAUTH_MCP_CWD || process.cwd()).trim();

let enabled = String(process.env.MCP_DEFAULT_ENABLED || "1").trim() !== "0";
let disabledReason = enabled ? "" : "manual";
let autoOffIdleS = Math.max(1, Number(process.env.MCP_AUTO_OFF_IDLE_S || "300"));
const loopIntervalS = Math.max(1, Number(process.env.MCP_LOOP_INTERVAL_S || "1"));
let lastActivityMs = Date.now();

/** @type {Client | null} */
let client = null;
/** @type {StdioClientTransport | null} */
let transport = null;
let connectingPromise = null;

function touchActivity() {
  lastActivityMs = Date.now();
  if (enabled) disabledReason = "";
}

function configPayload() {
  const idleS = Math.max(0, Math.floor((Date.now() - lastActivityMs) / 1000));
  const remaining = Math.max(0, Math.floor(autoOffIdleS - idleS));
  return {
    enabled,
    auto_off_idle_s: autoOffIdleS,
    disabled_reason: disabledReason || null,
    seconds_until_auto_off: enabled ? remaining : 0,
    mcp_command: MCP_COMMAND,
    mcp_args: MCP_ARGS,
    mcp_cwd: MCP_CWD,
  };
}

function autoOffTick() {
  if (!enabled) return;
  const idleMs = Date.now() - lastActivityMs;
  if (idleMs >= autoOffIdleS * 1000) {
    enabled = false;
    disabledReason = "idle_auto_off";
  }
}

async function ensureClient() {
  if (client) return client;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    const nextClient = new Client(
      { name: "ottoauth-http-bridge", version: "0.1.0" },
      { capabilities: {} },
    );
    const nextTransport = new StdioClientTransport({
      command: MCP_COMMAND,
      args: MCP_ARGS,
      cwd: MCP_CWD,
      env: process.env,
      stderr: "pipe",
    });
    await nextClient.connect(nextTransport);
    client = nextClient;
    transport = nextTransport;
    return nextClient;
  })();

  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

async function closeClient() {
  try {
    if (client) {
      await client.close();
    }
  } catch (_err) {
  } finally {
    client = null;
    transport = null;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_err) {
        resolve({ __raw: raw });
      }
    });
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function listTools() {
  const c = await ensureClient();
  const out = await c.listTools();
  return out?.tools || [];
}

async function callTool(name, args = {}) {
  const c = await ensureClient();
  return c.callTool({
    name,
    arguments: args || {},
  });
}

const server = http.createServer(async (req, res) => {
  const method = (req.method || "GET").toUpperCase();
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok", service: "ottoauth-mcp-http-bridge" });
  }

  if (method === "GET" && url.pathname === "/config") {
    return sendJson(res, 200, configPayload());
  }

  if (method === "POST" && url.pathname === "/config") {
    const body = await readBody(req);
    if (typeof body.enabled === "boolean") {
      enabled = body.enabled;
      disabledReason = enabled ? "" : "manual";
      if (enabled) touchActivity();
    }
    if (body.auto_off_idle_s !== undefined) {
      const n = Number(body.auto_off_idle_s);
      if (Number.isFinite(n) && n > 0) {
        autoOffIdleS = Math.floor(n);
      }
    }
    return sendJson(res, 200, configPayload());
  }

  if (method === "GET" && url.pathname === "/tools") {
    try {
      const tools = await listTools();
      return sendJson(res, 200, {
        enabled,
        count: tools.length,
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title || "",
          description: t.description || "",
        })),
      });
    } catch (error) {
      return sendJson(res, 502, { error: "list_tools_failed", detail: String(error) });
    }
  }

  if (method === "POST" && url.pathname === "/tool/echo") {
    const body = await readBody(req);
    touchActivity();
    return sendJson(res, 200, {
      ok: true,
      output: String(body.text || ""),
      source: "bridge_echo_compat",
    });
  }

  if (method === "POST" && url.pathname === "/tool/call") {
    if (!enabled) {
      return sendJson(res, 409, {
        error: "mcp_disabled",
        disabled_reason: disabledReason || "manual",
        ...configPayload(),
      });
    }
    const body = await readBody(req);
    const tool = String(body.tool || body.name || "").trim();
    if (!tool) {
      return sendJson(res, 400, { error: "tool is required" });
    }
    const argumentsPayload =
      body.arguments && typeof body.arguments === "object" ? body.arguments : {};
    try {
      touchActivity();
      const out = await callTool(tool, argumentsPayload);
      return sendJson(res, 200, {
        ok: !Boolean(out?.isError),
        tool,
        result: out || {},
      });
    } catch (error) {
      return sendJson(res, 502, { ok: false, tool, error: String(error) });
    }
  }

  return sendJson(res, 404, { error: "not_found" });
});

setInterval(autoOffTick, loopIntervalS * 1000).unref();

server.listen(PORT, HOST, () => {
  process.stderr.write(
    `[ottoauth-mcp-http-bridge] listening on http://${HOST}:${PORT}, command=${MCP_COMMAND} args=${MCP_ARGS.join(" ")} cwd=${MCP_CWD}\n`,
  );
});

process.on("SIGINT", async () => {
  await closeClient();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await closeClient();
  process.exit(0);
});
