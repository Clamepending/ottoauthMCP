import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const DEFAULT_WEBHOOK_PATH = "/webhooks/ottoauth";
const DEFAULT_WEBHOOK_PORT = 3789;
const DEFAULT_WEBHOOK_HOST = "127.0.0.1";
const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_RETRY_MAX = 8;
const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_WORKER_INTERVAL_MS = 1_000;

/**
 * @typedef {'pending'|'retrying'|'delivered'|'dead_letter'} WebhookEventStatus
 */

/**
 * @typedef {Object} StoredWebhookEvent
 * @property {string} id
 * @property {string | null} type
 * @property {unknown} payload
 * @property {string} received_at
 * @property {WebhookEventStatus} status
 * @property {number} attempt_count
 * @property {string | null} last_error
 * @property {string} next_attempt_at
 * @property {string | null} last_attempt_at
 * @property {string | null} delivered_at
 */

/**
 * @param {{
 * fetchImpl?: typeof fetch;
 * logger?: Pick<Console, 'error'>;
 * webhookPath?: string;
 * listenHost?: string;
 * listenPort?: number;
 * webhookSecret?: string;
 * allowUnsigned?: boolean;
 * maxSkewMs?: number;
 * gatewayUrl?: string;
 * gatewayAuthToken?: string;
 * retryBaseMs?: number;
 * retryMax?: number;
 * workerIntervalMs?: number;
 * storePath?: string;
 * }} [options]
 */
export function createWebhookRelay(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? console;
  const webhookPath = normalizeWebhookPath(options.webhookPath ?? process.env.OTTOAUTH_WEBHOOK_PATH ?? DEFAULT_WEBHOOK_PATH);
  const listenHost = options.listenHost ?? process.env.OTTOAUTH_WEBHOOK_HOST ?? DEFAULT_WEBHOOK_HOST;
  const listenPort = Number(options.listenPort ?? process.env.OTTOAUTH_WEBHOOK_PORT ?? DEFAULT_WEBHOOK_PORT);
  const webhookSecret = String(options.webhookSecret ?? process.env.OTTOAUTH_WEBHOOK_SECRET ?? "");
  const allowUnsigned =
    options.allowUnsigned ?? process.env.OTTOAUTH_WEBHOOK_ALLOW_UNSIGNED === "1";
  const maxSkewMs = Number(options.maxSkewMs ?? process.env.OTTOAUTH_WEBHOOK_MAX_SKEW_MS ?? DEFAULT_MAX_SKEW_MS);
  const retryBaseMs = Number(options.retryBaseMs ?? process.env.WEBHOOK_RETRY_BASE_MS ?? DEFAULT_RETRY_BASE_MS);
  const retryMax = Number(options.retryMax ?? process.env.WEBHOOK_RETRY_MAX ?? DEFAULT_RETRY_MAX);
  const workerIntervalMs = Number(options.workerIntervalMs ?? process.env.WEBHOOK_WORKER_INTERVAL_MS ?? DEFAULT_WORKER_INTERVAL_MS);
  const storePath =
    options.storePath ??
    process.env.WEBHOOK_EVENT_STORE_PATH ??
    path.join(process.cwd(), ".ottoauth-webhook-events.json");

  let gatewayUrl = String(options.gatewayUrl ?? process.env.AGENT_GATEWAY_URL ?? "").trim();
  let gatewayAuthToken = String(options.gatewayAuthToken ?? process.env.AGENT_GATEWAY_AUTH_TOKEN ?? "").trim();

  /** @type {Map<string, StoredWebhookEvent>} */
  const events = new Map();
  let persistQueue = Promise.resolve();

  /** @type {http.Server | null} */
  let server = null;
  /** @type {NodeJS.Timeout | null} */
  let worker = null;
  let running = false;

  async function start() {
    await loadStore();

    server = http.createServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${listenHost}`);

      if (method === "POST" && url.pathname === webhookPath) {
        const rawBody = await readRawBody(req);
        const result = await receiveRawWebhook(rawBody, req.headers);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }

      if (method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            webhook_path: webhookPath,
            webhook_port: listenPort,
            events: events.size,
            gateway_configured: Boolean(gatewayUrl),
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, listenHost, () => {
        server?.off("error", reject);
        resolve();
      });
    });

    running = true;
    worker = setInterval(() => {
      processDueEvents().catch((error) => {
        logger.error("[ottoauth-mcp:webhook] relay worker failed:", error);
      });
    }, workerIntervalMs);
    worker.unref();
  }

  async function stop() {
    running = false;
    if (worker) {
      clearInterval(worker);
      worker = null;
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
  }

  /**
   * @param {string} rawBody
   * @param {http.IncomingHttpHeaders | Record<string, string | string[] | undefined>} headers
   */
  async function receiveRawWebhook(rawBody, headers) {
    const sig = verifyWebhookSignature({
      rawBody,
      headers,
      secret: webhookSecret,
      allowUnsigned,
      maxSkewMs,
    });

    if (!sig.ok) {
      return {
        status: 401,
        body: { ok: false, error: "invalid_signature", reason: sig.reason },
      };
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { ok: false, error: "invalid_json" } };
    }

    const eventId = extractEventId(payload, rawBody);
    const existing = events.get(eventId);
    if (existing) {
      return {
        status: 200,
        body: { ok: true, duplicate: true, event_id: eventId, status: existing.status },
      };
    }

    const now = new Date();
    const event = {
      id: eventId,
      type: extractEventType(payload),
      payload,
      received_at: now.toISOString(),
      status: "pending",
      attempt_count: 0,
      last_error: null,
      next_attempt_at: now.toISOString(),
      last_attempt_at: null,
      delivered_at: null,
    };
    events.set(event.id, event);
    await persistStore();

    processDueEvents().catch((error) => {
      logger.error("[ottoauth-mcp:webhook] immediate relay failed:", error);
    });

    return {
      status: 202,
      body: { ok: true, accepted: true, event_id: event.id, status: event.status },
    };
  }

  async function processDueEvents() {
    if (!running) return;
    if (!gatewayUrl) return;

    const now = Date.now();
    const due = [...events.values()]
      .filter((e) => (e.status === "pending" || e.status === "retrying") && Date.parse(e.next_attempt_at) <= now)
      .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at));

    for (const event of due) {
      await relayEvent(event.id);
    }
  }

  /** @param {string} eventId */
  async function relayEvent(eventId) {
    const event = events.get(eventId);
    if (!event) {
      return { ok: false, error: "not_found" };
    }

    if (!gatewayUrl) {
      return { ok: false, error: "gateway_not_configured" };
    }

    event.attempt_count += 1;
    event.last_attempt_at = new Date().toISOString();

    try {
      const res = await fetchImpl(gatewayUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(gatewayAuthToken ? { authorization: `Bearer ${gatewayAuthToken}` } : {}),
          "x-ottoauth-event-id": event.id,
          ...(event.type ? { "x-ottoauth-event-type": event.type } : {}),
        },
        body: JSON.stringify({
          source: "ottoauth",
          relayed_at: new Date().toISOString(),
          event_id: event.id,
          event_type: event.type,
          event: event.payload,
        }),
      });

      if (res.ok) {
        event.status = "delivered";
        event.last_error = null;
        event.delivered_at = new Date().toISOString();
        await persistStore();
        return { ok: true, status: event.status };
      }

      const body = await res.text();
      return await scheduleRetry(event, `HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ""}`);
    } catch (error) {
      return await scheduleRetry(event, error instanceof Error ? error.message : String(error));
    }
  }

  /** @param {StoredWebhookEvent} event @param {string} reason */
  async function scheduleRetry(event, reason) {
    event.last_error = reason;
    if (event.attempt_count >= retryMax) {
      event.status = "dead_letter";
      await persistStore();
      return { ok: false, status: event.status, error: reason };
    }

    const backoff = retryBaseMs * 2 ** Math.max(0, event.attempt_count - 1);
    event.status = "retrying";
    event.next_attempt_at = new Date(Date.now() + backoff).toISOString();
    await persistStore();
    return { ok: false, status: event.status, error: reason };
  }

  /** @param {{ status?: WebhookEventStatus; limit?: number; offset?: number }} [input] */
  function listEvents(input = {}) {
    const status = input.status;
    const limit = clampNumber(input.limit ?? 50, 1, 500);
    const offset = clampNumber(input.offset ?? 0, 0, 10_000);

    const filtered = [...events.values()]
      .filter((e) => (!status ? true : e.status === status))
      .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));

    return {
      total: filtered.length,
      limit,
      offset,
      events: filtered.slice(offset, offset + limit),
    };
  }

  /** @param {string} id */
  function getEvent(id) {
    return events.get(id) ?? null;
  }

  /** @param {string} id */
  async function replayEvent(id) {
    const event = events.get(id);
    if (!event) {
      return { ok: false, error: "not_found" };
    }
    event.status = "pending";
    event.last_error = null;
    event.next_attempt_at = new Date().toISOString();
    await persistStore();
    const relay = await relayEvent(id);
    return { ok: true, event, relay };
  }

  /** @param {{ gatewayUrl?: string; gatewayAuthToken?: string }} input */
  function setGateway(input) {
    if (typeof input.gatewayUrl === "string") {
      gatewayUrl = input.gatewayUrl.trim();
    }
    if (typeof input.gatewayAuthToken === "string") {
      gatewayAuthToken = input.gatewayAuthToken.trim();
    }
    return {
      ok: true,
      gateway_configured: Boolean(gatewayUrl),
      gateway_url: gatewayUrl || null,
    };
  }

  function getStatus() {
    return {
      running,
      webhook_path: webhookPath,
      webhook_host: listenHost,
      webhook_port: listenPort,
      gateway_configured: Boolean(gatewayUrl),
      gateway_url: gatewayUrl || null,
      events_total: events.size,
      retry_max: retryMax,
      retry_base_ms: retryBaseMs,
      store_path: storePath,
    };
  }

  async function loadStore() {
    const raw = await fs.readFile(storePath, "utf8").catch(() => "");
    if (!raw) return;

    let parsed = [];
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.error("[ottoauth-mcp:webhook] invalid store json, starting with empty store");
      return;
    }

    if (!Array.isArray(parsed)) return;
    for (const row of parsed) {
      if (row && typeof row.id === "string") {
        events.set(row.id, row);
      }
    }
  }

  async function persistStore() {
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(async () => {
        const payload = JSON.stringify([...events.values()], null, 2);
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        await fs.writeFile(storePath, payload + "\n", "utf8");
      });

    await persistQueue;
  }

  return {
    start,
    stop,
    receiveRawWebhook,
    processDueEvents,
    relayEvent,
    listEvents,
    getEvent,
    replayEvent,
    setGateway,
    getStatus,
  };
}

/**
 * @param {{
 * rawBody: string;
 * headers: http.IncomingHttpHeaders | Record<string, string | string[] | undefined>;
 * secret: string;
 * allowUnsigned: boolean;
 * maxSkewMs: number;
 * }} input
 */
export function verifyWebhookSignature({ rawBody, headers, secret, allowUnsigned, maxSkewMs }) {
  const signatureHeader = getHeader(headers, "x-ottoauth-signature");
  const timestampHeader = getHeader(headers, "x-ottoauth-timestamp");

  if (!secret) {
    if (allowUnsigned) {
      return { ok: true };
    }
    return { ok: false, reason: "missing_webhook_secret" };
  }

  if (!signatureHeader || !timestampHeader) {
    return { ok: false, reason: "missing_signature_headers" };
  }

  const timestampMs = parseTimestamp(timestampHeader);
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  if (Math.abs(Date.now() - timestampMs) > maxSkewMs) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestampHeader}.${rawBody}`)
    .digest("hex");

  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: "signature_mismatch" };
  }

  const valid = crypto.timingSafeEqual(providedBuf, expectedBuf);
  return valid ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

/** @param {unknown} payload @param {string} rawBody */
export function extractEventId(payload, rawBody) {
  if (payload && typeof payload === "object") {
    const p = /** @type {Record<string, unknown>} */ (payload);
    const candidate = p.id ?? p.event_id ?? p.eventId;
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return `evt_${crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 24)}`;
}

/** @param {unknown} payload */
export function extractEventType(payload) {
  if (payload && typeof payload === "object") {
    const p = /** @type {Record<string, unknown>} */ (payload);
    const candidate = p.type ?? p.event_type ?? p.eventType;
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

/** @param {http.IncomingMessage} req */
export async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** @param {string} value */
export function normalizeWebhookPath(value) {
  const trimmed = (value || "").trim();
  if (!trimmed.startsWith("/")) {
    throw new Error(`Webhook path must start with '/': ${value}`);
  }
  return trimmed.replace(/\/{2,}/g, "/");
}

/** @param {string} value */
export function parseTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  if (raw.length <= 10) {
    return n * 1000;
  }
  return n;
}

/**
 * @param {http.IncomingHttpHeaders | Record<string, string | string[] | undefined>} headers
 * @param {string} key
 */
function getHeader(headers, key) {
  const val = headers[key] ?? headers[key.toLowerCase()];
  if (Array.isArray(val)) return val[0] ?? "";
  return typeof val === "string" ? val : "";
}

function clampNumber(input, min, max) {
  const n = Number(input);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
