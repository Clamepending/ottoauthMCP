import { describe, it, expect } from "vitest";
import { forwardRequest, fetchWithTimeout } from "../../src/server.mjs";
import { startMockOttoauth } from "../helpers.mjs";

describe("forwardRequest", () => {
  it("forwards JSON body, headers, and query params", async () => {
    const mock = await startMockOttoauth();

    try {
      const out = await forwardRequest({
        baseUrl: mock.baseUrl,
        method: "POST",
        path: "/api/services/amazon/buy",
        query: { foo: "bar", skip: null, n: 1 },
        body: { username: "agent", private_key: "k" },
        headers: { "x-test": "yes" },
        fetchImpl: fetch,
        httpTimeoutMs: 3_000,
      });

      expect(out.ok).toBe(true);
      expect(out.status).toBe(200);
      expect(out.body.endpoint).toBe("buy");

      const req = mock.requests.at(-1);
      expect(req.query).toContain("foo=bar");
      expect(req.query).toContain("n=1");
      expect(req.query).not.toContain("skip=");
      expect(req.body).toEqual({ username: "agent", private_key: "k" });
      expect(req.headers["x-test"]).toBe("yes");
      expect(req.headers["content-type"]).toContain("application/json");
    } finally {
      await mock.close();
    }
  });

  it("does not send body for GET", async () => {
    const mock = await startMockOttoauth({
      handlers: {
        "GET /api/custom/echo": (_req, body) => ({ ok: true, body }),
      },
    });

    try {
      const out = await forwardRequest({
        baseUrl: mock.baseUrl,
        method: "GET",
        path: "/api/custom/echo",
        body: { should: "ignore" },
        fetchImpl: fetch,
        httpTimeoutMs: 3_000,
      });

      expect(out.ok).toBe(true);
      expect(out.body.body).toBeNull();
      const req = mock.requests.at(-1);
      expect(req.body).toBeNull();
    } finally {
      await mock.close();
    }
  });

  it("parses plain text responses", async () => {
    const mock = await startMockOttoauth({
      handlers: {
        "POST /api/services/amazon/buy": () => "plain-text-ok",
      },
    });

    try {
      const out = await forwardRequest({
        baseUrl: mock.baseUrl,
        method: "POST",
        path: "/api/services/amazon/buy",
        fetchImpl: fetch,
        httpTimeoutMs: 3_000,
      });

      expect(out.ok).toBe(true);
      expect(out.contentType).toContain("text/plain");
      expect(out.body).toBe("plain-text-ok");
    } finally {
      await mock.close();
    }
  });

  it("propagates non-2xx status without throwing", async () => {
    const mock = await startMockOttoauth({
      handlers: {
        "POST /api/services/amazon/buy": () => ({ __status: 422, body: { error: "bad" } }),
      },
    });

    try {
      const out = await forwardRequest({
        baseUrl: mock.baseUrl,
        method: "POST",
        path: "/api/services/amazon/buy",
        fetchImpl: fetch,
        httpTimeoutMs: 3_000,
      });

      expect(out.ok).toBe(false);
      expect(out.status).toBe(422);
      expect(out.body.error).toBe("bad");
    } finally {
      await mock.close();
    }
  });

  it("supports dynamic path endpoints", async () => {
    const mock = await startMockOttoauth();
    try {
      const out = await forwardRequest({
        baseUrl: mock.baseUrl,
        method: "POST",
        path: "/api/computeruse/runs/abc/events",
        body: { limit: 10 },
        fetchImpl: fetch,
        httpTimeoutMs: 3_000,
      });
      expect(out.ok).toBe(true);
      expect(out.body.endpoint).toBe("events");
    } finally {
      await mock.close();
    }
  });

  it("aborts on timeout", async () => {
    const slowFetch = async (_url, init) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    await expect(
      fetchWithTimeout(slowFetch, "http://127.0.0.1:1", { method: "GET" }, 5),
    ).rejects.toThrow(/AbortError|aborted/i);
  });
});
