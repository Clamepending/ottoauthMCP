import { describe, it, expect } from "vitest";
import {
  extractEndpointsFromMarkdown,
  normalizeDiscoveredPath,
  safeServiceId,
} from "../../src/server.mjs";

describe("endpoint parsing", () => {
  const baseUrl = "http://127.0.0.1:3000";

  it("parses direct METHOD path style", () => {
    const md = "```bash\nPOST /api/services/amazon/buy\n```";
    const endpoints = extractEndpointsFromMarkdown(md, "amazon", baseUrl);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].method).toBe("POST");
    expect(endpoints[0].path).toBe("/api/services/amazon/buy");
  });

  it("parses curl -X style", () => {
    const md = "```bash\ncurl -s -X POST /api/services/amazon/history -d '{}'\n```";
    const endpoints = extractEndpointsFromMarkdown(md, "amazon", baseUrl);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].path).toBe("/api/services/amazon/history");
  });

  it("ignores non /api paths", () => {
    const md = "```bash\nGET /health\n```";
    const endpoints = extractEndpointsFromMarkdown(md, "amazon", baseUrl);
    expect(endpoints).toHaveLength(0);
  });

  it("normalizes placeholder path segments", () => {
    const path = normalizeDiscoveredPath("/api/computeruse/runs/RUN_ID_HERE/events", baseUrl);
    expect(path).toBe("/api/computeruse/runs/:run_id/events");
  });

  it("supports absolute URLs", () => {
    const path = normalizeDiscoveredPath(
      "https://api.example.com/api/services/amazon/buy",
      baseUrl,
    );
    expect(path).toBe("/api/services/amazon/buy");
  });

  it("returns null for unsupported discovered paths", () => {
    expect(normalizeDiscoveredPath("/", baseUrl)).toBeNull();
    expect(normalizeDiscoveredPath("/foo/bar", baseUrl)).toBeNull();
  });

  it("sanitizes service ids", () => {
    expect(safeServiceId(" AmAzOn ")).toBe("amazon");
    expect(safeServiceId("a!@#b")).toBe("ab");
    expect(safeServiceId(42)).toBeNull();
    expect(safeServiceId("   ")).toBeNull();
  });

  it("extracts multiple endpoints across code blocks", () => {
    const md = [
      "```bash",
      "POST /api/services/amazon/buy",
      "```",
      "text",
      "```bash",
      "curl -X POST /api/services/amazon/history",
      "```",
    ].join("\n");
    const endpoints = extractEndpointsFromMarkdown(md, "amazon", baseUrl);
    expect(endpoints.map((e) => e.path).sort()).toEqual([
      "/api/services/amazon/buy",
      "/api/services/amazon/history",
    ]);
  });
});
