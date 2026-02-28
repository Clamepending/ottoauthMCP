import { describe, it, expect } from "vitest";
import { isListServicesRequest } from "../../src/server.mjs";

describe("list services refresh hook", () => {
  it("matches GET /api/services variants", () => {
    expect(isListServicesRequest("GET", "/api/services")).toBe(true);
    expect(isListServicesRequest("get", "/api/services/"))
      .toBe(true);
    expect(isListServicesRequest("GET", "/api/services//"))
      .toBe(true);
  });

  it("does not match non-list-services calls", () => {
    expect(isListServicesRequest("POST", "/api/services")).toBe(false);
    expect(isListServicesRequest("GET", "/api/services/amazon")).toBe(false);
    expect(isListServicesRequest("GET", "/api/onboard")).toBe(false);
  });
});
