import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../functions/[[path]]";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare Pages Functions adapter", () => {
  it("serves the health response through the catch-all route", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await onRequest({
      request: new Request("https://dhpc.pages.dev/"),
      env: {},
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runtime: "Cloudflare Pages Functions",
      status: "ok",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses Pages environment variables for access restrictions", async () => {
    const response = await onRequest({
      request: new Request("https://dhpc.pages.dev/v2/", {
        headers: { "cf-connecting-ip": "198.51.100.8" },
      }),
      env: { ALLOWED_IPS: "203.0.113.10" },
    });

    expect(response.status).toBe(403);
  });
});
