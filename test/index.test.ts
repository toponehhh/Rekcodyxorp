import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { testing } from "../src/index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Docker Hub Worker proxy", () => {
  it("reports its health without contacting Docker Hub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request("https://mirror.example.com/"), {});

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", registry: "/v2/" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rewrites Docker Hub's bearer-token realm to the public proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
          "docker-distribution-api-version": "registry/2.0",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request("https://mirror.example.com/v2/"), {});

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="https://mirror.example.com/token",service="registry.docker.io"',
    );
    expect(fetchMock.mock.calls[0][0].toString()).toBe("https://registry-1.docker.io/v2/");
  });

  it("forwards token queries and client credentials to Docker auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ token: "test-token", expires_in: 300 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request(
      "https://mirror.example.com/token?service=registry.docker.io&scope=repository%3Alibrary%2Falpine%3Apull",
      { headers: { authorization: "Basic credentials" } },
    );

    const response = await worker.fetch(request, {});

    expect(response.status).toBe(200);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target.toString()).toContain("https://auth.docker.io/token?service=registry.docker.io");
    expect((init.headers as Headers).get("authorization")).toBe("Basic credentials");
  });

  it("streams a redirected layer through the Worker without leaking authorization", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://production.cloudflare.docker.com/registry-v2/layer" },
        }),
      )
      .mockResolvedValueOnce(new Response("layer-bytes", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request(
      "https://mirror.example.com/v2/library/alpine/blobs/sha256:abc",
      { headers: { authorization: "Bearer registry-token", range: "bytes=0-" } },
    );

    const response = await worker.fetch(request, {});

    expect(await response.text()).toBe("layer-bytes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const redirectedHeaders = fetchMock.mock.calls[1][1].headers as Headers;
    expect(redirectedHeaders.get("authorization")).toBeNull();
    expect(redirectedHeaders.get("range")).toBe("bytes=0-");
  });

  it("supports optional IP allowlisting", async () => {
    const response = await worker.fetch(
      new Request("https://mirror.example.com/v2/", {
        headers: { "cf-connecting-ip": "198.51.100.8" },
      }),
      { ALLOWED_IPS: "203.0.113.10" },
    );

    expect(response.status).toBe(403);
  });

  it("rejects writes", async () => {
    const response = await worker.fetch(
      new Request("https://mirror.example.com/v2/library/alpine/manifests/latest", { method: "PUT" }),
      {},
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("redirect policy", () => {
  it("accepts Docker's known CDN and refuses arbitrary hosts", () => {
    expect(testing.isAllowedUpstream(new URL("https://production.cloudflare.docker.com/a"))).toBe(true);
    expect(testing.isAllowedUpstream(new URL("https://evil.example/a"))).toBe(false);
    expect(testing.isAllowedUpstream(new URL("http://registry-1.docker.io/v2/"))).toBe(false);
  });
});
