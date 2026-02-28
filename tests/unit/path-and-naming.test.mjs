import { describe, it, expect } from "vitest";
import {
  applyPathParams,
  normalizePath,
  getBaseUrl,
  toToolName,
  responseToMcp,
} from "../../src/server.mjs";

describe("path and naming helpers", () => {
  it("normalizes repeated slashes", () => {
    expect(normalizePath("/api//services///amazon/buy")).toBe(
      "/api/services/amazon/buy",
    );
  });

  it("throws when path is empty or relative", () => {
    expect(() => normalizePath("   ")).toThrow(/Path is required/);
    expect(() => normalizePath("api/services")).toThrow(/must start/);
  });

  it("applies path parameters", () => {
    expect(applyPathParams("/api/runs/:run_id/events", { run_id: "abc-1" })).toBe(
      "/api/runs/abc-1/events",
    );
  });

  it("URL-encodes path params", () => {
    expect(applyPathParams("/api/runs/:run_id", { run_id: "x y/z" })).toBe(
      "/api/runs/x%20y%2Fz",
    );
  });

  it("throws when required path param is missing", () => {
    expect(() => applyPathParams("/api/runs/:run_id", {})).toThrow(/Missing required/);
  });

  it("builds normalized tool names", () => {
    expect(toToolName("amazon", "POST", "/api/services/amazon/buy")).toBe(
      "ottoauth_amazon_post_services_amazon_buy",
    );
    expect(toToolName("computeruse", "POST", "/api/computeruse/runs/:run_id/events")).toBe(
      "ottoauth_computeruse_post_computeruse_runs_run_id_events",
    );
  });

  it("normalizes base url", () => {
    expect(getBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(() => getBaseUrl("not-a-url")).toThrow();
  });

  it("maps HTTP responses to MCP result shape", () => {
    const out = responseToMcp({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      url: "http://x/api",
      contentType: "application/json",
      body: { error: "bad" },
    });
    expect(out.isError).toBe(true);
    expect(out.structuredContent.status).toBe(400);
    expect(out.content[0].type).toBe("text");
  });
});
