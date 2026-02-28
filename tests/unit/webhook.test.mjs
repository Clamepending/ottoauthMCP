import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  createWebhookRelay,
  extractEventId,
  normalizeWebhookPath,
  parseTimestamp,
  verifyWebhookSignature,
} from "../../src/webhook.mjs";

function sign(secret, timestamp, body) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `sha256=${digest}`;
}

async function startGateway(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      raw += c;
    });
    await new Promise((resolve) => req.on("end", resolve));

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }

    requests.push({ method: req.method, path: req.url, headers: req.headers, body: parsed });
    const out = handler ? await handler(req, parsed) : { status: 200, body: { ok: true } };
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body ?? {}));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/gateway`,
    requests,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("webhook helpers", () => {
  it("validates signature correctly", () => {
    const secret = "abc";
    const body = JSON.stringify({ id: "evt_1" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(secret, ts, body);

    const ok = verifyWebhookSignature({
      rawBody: body,
      headers: {
        "x-ottoauth-timestamp": ts,
        "x-ottoauth-signature": sig,
      },
      secret,
      allowUnsigned: false,
      maxSkewMs: 60_000,
    });
    expect(ok.ok).toBe(true);

    const bad = verifyWebhookSignature({
      rawBody: body,
      headers: {
        "x-ottoauth-timestamp": ts,
        "x-ottoauth-signature": "sha256=bad",
      },
      secret,
      allowUnsigned: false,
      maxSkewMs: 60_000,
    });
    expect(bad.ok).toBe(false);
  });

  it("supports unsigned mode only when enabled", () => {
    const body = "{}";
    expect(
      verifyWebhookSignature({
        rawBody: body,
        headers: {},
        secret: "",
        allowUnsigned: true,
        maxSkewMs: 60_000,
      }).ok,
    ).toBe(true);

    expect(
      verifyWebhookSignature({
        rawBody: body,
        headers: {},
        secret: "",
        allowUnsigned: false,
        maxSkewMs: 60_000,
      }).ok,
    ).toBe(false);
  });

  it("normalizes webhook path and parses timestamp", () => {
    expect(normalizeWebhookPath("/webhooks//ottoauth")).toBe("/webhooks/ottoauth");
    expect(() => normalizeWebhookPath("webhooks/ottoauth")).toThrow();
    expect(parseTimestamp("1700000000")).toBe(1700000000 * 1000);
  });

  it("extracts stable fallback event id", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(extractEventId({}, body)).toMatch(/^evt_/);
  });
});

describe("webhook relay", () => {
  it("accepts signed webhook, dedupes, and relays to gateway", async () => {
    const gateway = await startGateway();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ottoauthmcp-webhook-"));
    const storePath = path.join(tmp, "events.json");

    const relay = createWebhookRelay({
      webhookSecret: "secret123",
      allowUnsigned: false,
      gatewayUrl: gateway.url,
      gatewayAuthToken: "token123",
      listenPort: 0,
      storePath,
      retryBaseMs: 10,
      workerIntervalMs: 20,
    });

    await relay.start();
    try {
      const body = JSON.stringify({ id: "evt_signed_1", type: "order.created", data: { a: 1 } });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = sign("secret123", ts, body);

      const first = await relay.receiveRawWebhook(body, {
        "x-ottoauth-signature": sig,
        "x-ottoauth-timestamp": ts,
      });
      expect(first.status).toBe(202);

      const second = await relay.receiveRawWebhook(body, {
        "x-ottoauth-signature": sig,
        "x-ottoauth-timestamp": ts,
      });
      expect(second.status).toBe(200);
      expect(second.body.duplicate).toBe(true);

      for (let i = 0; i < 20 && gateway.requests.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(gateway.requests.length).toBe(1);
      expect(gateway.requests[0].headers.authorization).toBe("Bearer token123");
      expect(gateway.requests[0].body.event_id).toBe("evt_signed_1");

      const event = relay.getEvent("evt_signed_1");
      expect(event?.status).toBe("delivered");

      const list = relay.listEvents({ status: "delivered" });
      expect(list.total).toBe(1);
    } finally {
      await relay.stop();
      await gateway.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("retries and moves to dead_letter when gateway keeps failing", async () => {
    const gateway = await startGateway(() => ({ status: 500, body: { error: "boom" } }));
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ottoauthmcp-webhook-"));
    const storePath = path.join(tmp, "events.json");

    const relay = createWebhookRelay({
      webhookSecret: "secret123",
      gatewayUrl: gateway.url,
      listenPort: 0,
      storePath,
      retryBaseMs: 5,
      retryMax: 2,
      workerIntervalMs: 10,
    });

    await relay.start();
    try {
      const body = JSON.stringify({ id: "evt_fail_1", type: "run.failed" });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = sign("secret123", ts, body);

      const accepted = await relay.receiveRawWebhook(body, {
        "x-ottoauth-signature": sig,
        "x-ottoauth-timestamp": ts,
      });
      expect(accepted.status).toBe(202);

      for (let i = 0; i < 50; i += 1) {
        const event = relay.getEvent("evt_fail_1");
        if (event?.status === "dead_letter") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const event = relay.getEvent("evt_fail_1");
      expect(event?.status).toBe("dead_letter");
      expect((event?.attempt_count ?? 0) >= 2).toBe(true);
    } finally {
      await relay.stop();
      await gateway.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
