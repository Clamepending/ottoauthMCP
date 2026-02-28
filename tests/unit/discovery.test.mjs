import { describe, it, expect } from "vitest";
import { discoverEndpoints } from "../../src/server.mjs";
import { startMockOttoauth } from "../helpers.mjs";

describe("discoverEndpoints", () => {
  it("discovers and de-duplicates endpoints from service docs", async () => {
    const mock = await startMockOttoauth({
      docsByServiceId: {
        amazon: `\`\`\`bash\nPOST /api/services/amazon/buy\n\`\`\`\n\n\`\`\`bash\ncurl -X POST /api/services/amazon/buy\n\`\`\``,
      },
      services: [{ id: "amazon" }],
    });

    try {
      const endpoints = await discoverEndpoints({
        baseUrl: mock.baseUrl,
        fetchImpl: fetch,
        httpTimeoutMs: 2_000,
      });

      expect(endpoints).toHaveLength(1);
      expect(endpoints[0].toolName).toBe("ottoauth_amazon_post_services_amazon_buy");
    } finally {
      await mock.close();
    }
  });

  it("skips services with bad ids and handles missing docs", async () => {
    const mock = await startMockOttoauth({
      services: [{ id: "***" }, { id: "amazon" }],
      docsByServiceId: {
        amazon: "no code blocks",
      },
    });

    try {
      const endpoints = await discoverEndpoints({
        baseUrl: mock.baseUrl,
        fetchImpl: fetch,
        httpTimeoutMs: 2_000,
      });
      expect(endpoints).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("throws when services endpoint errors", async () => {
    const mock = await startMockOttoauth({
      handlers: {
        "GET /api/services": () => ({ __status: 500, body: { error: "boom" } }),
      },
    });

    // override by hitting non-existing path for services using baseURL trick
    try {
      await expect(
        discoverEndpoints({
          baseUrl: `${mock.baseUrl}/bad-base`,
          fetchImpl: fetch,
          httpTimeoutMs: 2_000,
        }),
      ).rejects.toThrow();
    } finally {
      await mock.close();
    }
  });
});
