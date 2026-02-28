import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWebhookRelay } from "./webhook.mjs";

export const DEFAULT_BASE_URL = "http://localhost:3000";
export const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * @typedef {Object} EndpointTool
 * @property {string} toolName
 * @property {string} title
 * @property {string} description
 * @property {string} method
 * @property {string} path
 * @property {string} serviceId
 */

/**
 * @param {{
 * baseUrl?: string;
 * refreshIntervalMs?: number;
 * httpTimeoutMs?: number;
 * fetchImpl?: typeof fetch;
 * logger?: Pick<Console, 'error'>;
 * webhookPath?: string;
 * webhookListenHost?: string;
 * webhookListenPort?: number;
 * webhookSecret?: string;
 * webhookAllowUnsigned?: boolean;
 * gatewayUrl?: string;
 * gatewayAuthToken?: string;
 * webhookStorePath?: string;
 * }} [options]
 */
export function createOttoauthMcpServer(options = {}) {
  const baseUrl = getBaseUrl(options.baseUrl);
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? console;
  const webhookRelay = createWebhookRelay({
    fetchImpl,
    logger,
    webhookPath: options.webhookPath,
    listenHost: options.webhookListenHost,
    listenPort: options.webhookListenPort,
    webhookSecret: options.webhookSecret,
    allowUnsigned: options.webhookAllowUnsigned,
    gatewayUrl: options.gatewayUrl,
    gatewayAuthToken: options.gatewayAuthToken,
    storePath: options.webhookStorePath,
  });

  /** @type {Map<string, EndpointTool>} */
  const endpointTools = new Map();
  /** @type {Map<string, import("@modelcontextprotocol/sdk/server/mcp.js").RegisteredTool>} */
  const registeredTools = new Map();

  let lastRefreshAt = 0;
  /** @type {Promise<void> | null} */
  let refreshPromise = null;
  /** @type {NodeJS.Timeout | null} */
  let refreshTimer = null;

  const server = new McpServer({
    name: "ottoauth-mcp-proxy",
    version: "0.1.0",
  });

  const endpointInputSchema = {
    path_params: z
      .record(z.string(), z.union([z.string(), z.number()]))
      .optional()
      .describe("Values for path placeholders (for example: runId)."),
    query: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional()
      .describe("Optional query string parameters."),
    body: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON body to forward as-is to Ottoauth."),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional additional HTTP headers."),
  };

  const genericRequestSchema = {
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .describe("HTTP method to call."),
    path: z
      .string()
      .describe("Absolute Ottoauth path like /api/services/amazon/buy."),
    query: endpointInputSchema.query,
    body: endpointInputSchema.body,
    headers: endpointInputSchema.headers,
  };

  server.registerTool(
    "ottoauth_http_request",
    {
      title: "Ottoauth HTTP Request",
      description:
        "Generic Ottoauth passthrough tool. Use this if no endpoint-specific tool matches your request.",
      inputSchema: genericRequestSchema,
    },
    async ({ method, path, query, body, headers }) => {
      const normalizedPath = normalizePath(path);
      const result = await forwardRequest({
        baseUrl,
        method,
        path: normalizedPath,
        query,
        body,
        headers,
        fetchImpl,
        httpTimeoutMs,
      });
      if (isListServicesRequest(method, normalizedPath) && result.ok) {
        await ensureFreshTools(true);
      }
      return responseToMcp(result);
    },
  );

  server.registerTool(
    "webhook_status",
    {
      title: "Webhook Status",
      description:
        "Get webhook receiver and relay status, including configured gateway and event counts.",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(webhookRelay.getStatus(), null, 2),
        },
      ],
      structuredContent: webhookRelay.getStatus(),
    }),
  );

  server.registerTool(
    "webhook_list_events",
    {
      title: "Webhook List Events",
      description:
        "List received webhook events with optional status filtering and pagination.",
      inputSchema: {
        status: z
          .enum(["pending", "retrying", "delivered", "dead_letter"])
          .optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).max(10000).optional(),
      },
    },
    async (args) => {
      const data = webhookRelay.listEvents(args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
      };
    },
  );

  server.registerTool(
    "webhook_get_event",
    {
      title: "Webhook Get Event",
      description: "Get a specific webhook event by id.",
      inputSchema: {
        event_id: z.string().min(1),
      },
    },
    async ({ event_id }) => {
      const event = webhookRelay.getEvent(event_id);
      if (!event) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: "not_found" }) }],
          structuredContent: { error: "not_found" },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
        structuredContent: event,
      };
    },
  );

  server.registerTool(
    "webhook_replay_event",
    {
      title: "Webhook Replay Event",
      description:
        "Force a webhook event to be re-queued and relayed immediately to the configured gateway.",
      inputSchema: {
        event_id: z.string().min(1),
      },
    },
    async ({ event_id }) => {
      const out = await webhookRelay.replayEvent(event_id);
      return {
        isError: !out.ok,
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    },
  );

  server.registerTool(
    "webhook_set_gateway",
    {
      title: "Webhook Set Gateway",
      description:
        "Update relay destination for webhook forwarding (can override env config at runtime).",
      inputSchema: {
        gateway_url: z.string().url().optional(),
        gateway_auth_token: z.string().optional(),
      },
    },
    async ({ gateway_url, gateway_auth_token }) => {
      const out = webhookRelay.setGateway({
        gatewayUrl: gateway_url,
        gatewayAuthToken: gateway_auth_token,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    },
  );

  async function start() {
    await webhookRelay.start();
    try {
      await refreshToolsFromOttoauth();
    } catch (error) {
      logger.error(
        "[ottoauth-mcp] initial tool discovery failed; continuing with generic passthrough tool:",
        error,
      );
    }

    refreshTimer = setInterval(() => {
      refreshToolsFromOttoauth().catch((error) => {
        logger.error("[ottoauth-mcp] scheduled refresh failed:", error);
      });
    }, refreshIntervalMs);
    refreshTimer.unref();
  }

  function stop() {
    webhookRelay.stop().catch((error) => {
      logger.error("[ottoauth-mcp] failed to stop webhook relay:", error);
    });
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  async function ensureFreshTools(force = false) {
    const stale = Date.now() - lastRefreshAt > refreshIntervalMs;
    if (force || stale || endpointTools.size === 0) {
      try {
        await refreshToolsFromOttoauth();
      } catch (error) {
        logger.error("[ottoauth-mcp] refresh skipped due to error:", error);
      }
    }
  }

  async function refreshToolsFromOttoauth() {
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      const discovered = await discoverEndpoints({
        baseUrl,
        fetchImpl,
        httpTimeoutMs,
      });

      endpointTools.clear();
      for (const endpoint of discovered) {
        endpointTools.set(endpoint.toolName, endpoint);
      }

      for (const [, handle] of registeredTools) {
        handle.remove();
      }
      registeredTools.clear();

      for (const endpoint of endpointTools.values()) {
        const handle = server.registerTool(
          endpoint.toolName,
          {
            title: endpoint.title,
            description: endpoint.description,
            inputSchema: endpointInputSchema,
          },
          async (args) => {
            await ensureFreshTools(false);
            const latest = endpointTools.get(endpoint.toolName) ?? endpoint;
            const path = applyPathParams(latest.path, args.path_params);
            const result = await forwardRequest({
              baseUrl,
              method: latest.method,
              path,
              query: args.query,
              body: args.body,
              headers: args.headers,
              fetchImpl,
              httpTimeoutMs,
            });
            return responseToMcp(result);
          },
        );
        registeredTools.set(endpoint.toolName, handle);
      }

      lastRefreshAt = Date.now();
      server.sendToolListChanged();
      logger.error(
        `[ottoauth-mcp] refreshed ${endpointTools.size} endpoint tools from ${baseUrl}`,
      );
    })();

    try {
      await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  return {
    server,
    start,
    stop,
    webhookRelay,
    refreshToolsFromOttoauth,
    ensureFreshTools,
    getSnapshot() {
      return {
        baseUrl,
        endpointCount: endpointTools.size,
        endpoints: [...endpointTools.values()],
        lastRefreshAt,
      };
    },
  };
}

/**
 * @param {{
 * baseUrl: string;
 * fetchImpl: typeof fetch;
 * httpTimeoutMs: number;
 * }} options
 * @returns {Promise<EndpointTool[]>}
 */
export async function discoverEndpoints({ baseUrl, fetchImpl, httpTimeoutMs }) {
  const servicesRes = await fetchWithTimeout(fetchImpl, `${baseUrl}/api/services`, {
    method: "GET",
    headers: { Accept: "application/json" },
  }, httpTimeoutMs);

  if (!servicesRes.ok) {
    throw new Error(
      `GET /api/services failed with status ${servicesRes.status} ${servicesRes.statusText}`,
    );
  }

  const payload = await servicesRes.json();
  const services = Array.isArray(payload?.services) ? payload.services : [];

  /** @type {Map<string, EndpointTool>} */
  const found = new Map();

  for (const service of services) {
    const serviceId = safeServiceId(service?.id);
    if (!serviceId) continue;

    const docsUrl =
      typeof service?.docsUrl === "string" && service.docsUrl
        ? service.docsUrl
        : `${baseUrl}/api/services/${serviceId}`;

    const docs = await fetchDocsMarkdown({ docsUrl, fetchImpl, httpTimeoutMs });
    const endpoints = extractEndpointsFromMarkdown(docs, serviceId, baseUrl);
    for (const endpoint of endpoints) {
      found.set(`${endpoint.method} ${endpoint.path}`, endpoint);
    }
  }

  return [...found.values()].sort((a, b) => a.toolName.localeCompare(b.toolName));
}

/**
 * @param {{ docsUrl: string; fetchImpl: typeof fetch; httpTimeoutMs: number }} options
 */
export async function fetchDocsMarkdown({ docsUrl, fetchImpl, httpTimeoutMs }) {
  const res = await fetchWithTimeout(fetchImpl, docsUrl, {
    method: "GET",
    headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
  }, httpTimeoutMs);

  if (!res.ok) {
    return "";
  }

  return res.text();
}

/**
 * @param {string} markdown
 * @param {string} serviceId
 * @param {string} baseUrl
 * @returns {EndpointTool[]}
 */
export function extractEndpointsFromMarkdown(markdown, serviceId, baseUrl) {
  const endpoints = [];
  if (!markdown) return endpoints;

  const codeBlocks = [...markdown.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);

  for (const block of codeBlocks) {
    const directEndpointMatches = block.matchAll(
      /\b(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/[^\s\\`]+|\/[^\s\\`]+)/g,
    );

    for (const match of directEndpointMatches) {
      const method = match[1];
      const rawPath = match[2];
      const path = normalizeDiscoveredPath(rawPath, baseUrl);
      if (!path) continue;
      endpoints.push(buildEndpointTool(serviceId, method, path));
    }

    const curlMatches = block.matchAll(
      /\bcurl\b[\s\S]*?\b-X\s+(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/[^\s\\`]+|\/[^\s\\`]+)/g,
    );

    for (const match of curlMatches) {
      const method = match[1];
      const rawPath = match[2];
      const path = normalizeDiscoveredPath(rawPath, baseUrl);
      if (!path) continue;
      endpoints.push(buildEndpointTool(serviceId, method, path));
    }
  }

  return endpoints;
}

/**
 * @param {string} serviceId
 * @param {string} method
 * @param {string} path
 * @returns {EndpointTool}
 */
export function buildEndpointTool(serviceId, method, path) {
  return {
    toolName: toToolName(serviceId, method, path),
    title: `${serviceId.toUpperCase()} ${method} ${path}`,
    description: `Passthrough to ${method} ${path} on Ottoauth.`,
    method,
    path,
    serviceId,
  };
}

/**
 * @param {{
 * baseUrl: string;
 * method: string;
 * path: string;
 * query?: Record<string, unknown>;
 * body?: Record<string, unknown>;
 * headers?: Record<string, string>;
 * fetchImpl: typeof fetch;
 * httpTimeoutMs: number;
 * }} input
 */
export async function forwardRequest({
  baseUrl,
  method,
  path,
  query,
  body,
  headers,
  fetchImpl,
  httpTimeoutMs,
}) {
  const url = new URL(path, `${baseUrl}/`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  const requestHeaders = {
    Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    ...(headers ?? {}),
  };

  const shouldSendBody = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (shouldSendBody) {
    requestHeaders["Content-Type"] =
      requestHeaders["Content-Type"] ?? "application/json";
  }

  const res = await fetchWithTimeout(fetchImpl, url.toString(), {
    method,
    headers: requestHeaders,
    body: shouldSendBody ? JSON.stringify(body ?? {}) : undefined,
  }, httpTimeoutMs);

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const responseBody = isJson ? await res.json() : await res.text();

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    url: url.toString(),
    contentType,
    body: responseBody,
  };
}

/**
 * @param {{ ok: boolean; status: number; statusText: string; url: string; contentType: string; body: unknown }} response
 */
export function responseToMcp(response) {
  const text = JSON.stringify(response, null, 2);
  return {
    isError: !response.ok,
    content: [{ type: "text", text }],
    structuredContent: response,
  };
}

/**
 * @param {string} pathTemplate
 * @param {Record<string, string | number> | undefined} pathParams
 */
export function applyPathParams(pathTemplate, pathParams) {
  return pathTemplate.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    const value = pathParams?.[name];
    if (value === undefined || value === null) {
      throw new Error(
        `Missing required path parameter '${name}' for path '${pathTemplate}'.`,
      );
    }
    return encodeURIComponent(String(value));
  });
}

/** @param {string} value */
export function normalizePath(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error("Path is required.");
  if (!trimmed.startsWith("/")) {
    throw new Error(`Path must start with '/': ${trimmed}`);
  }
  return trimmed.replace(/\/{2,}/g, "/");
}

/**
 * @param {string} method
 * @param {string} path
 */
export function isListServicesRequest(method, path) {
  return (
    String(method).toUpperCase() === "GET" &&
    String(path).replace(/\/+$/, "") === "/api/services"
  );
}

/**
 * @param {string} value
 * @param {string} baseUrl
 */
export function normalizeDiscoveredPath(value, baseUrl) {
  const url = value.startsWith("http")
    ? new URL(value)
    : new URL(value, `${baseUrl}/`);

  let path = normalizePath(url.pathname);
  if (!path.startsWith("/api/")) return null;

  path = path
    .split("/")
    .map((segment) => {
      if (/^[A-Z][A-Z0-9_]+$/.test(segment)) {
        const normalized = segment.replace(/_HERE$/g, "").toLowerCase();
        return `:${normalized}`;
      }
      return segment;
    })
    .join("/");

  return path;
}

/** @param {string | undefined} raw */
export function getBaseUrl(raw) {
  const value = (raw ?? process.env.OTTOAUTH_BASE_URL ?? DEFAULT_BASE_URL).trim();
  const url = new URL(value);
  return url.toString().replace(/\/$/, "");
}

/**
 * @param {string} serviceId
 * @param {string} method
 * @param {string} path
 */
export function toToolName(serviceId, method, path) {
  const normalizedPath = path
    .replace(/^\/api\//, "")
    .replace(/[:/]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `ottoauth_${serviceId}_${method.toLowerCase()}_${normalizedPath}`;
}

/** @param {unknown} raw */
export function safeServiceId(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  return value.replace(/[^a-z0-9_-]/g, "");
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
export async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
