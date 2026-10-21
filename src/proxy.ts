const REGISTRY_ORIGIN = "https://registry-1.docker.io";
const AUTH_ORIGIN = "https://auth.docker.io";
const MAX_REDIRECTS = 5;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ResponseFactory = (
  body: BodyInit | null,
  init: ResponseInit,
) => Response;

export interface DockerHubProxyOptions {
  runtime: string;
  proxyHeader: string;
  fetcher?: Fetcher;
  isRequestAllowed?: (request: Request) => boolean | Promise<boolean>;
  responseFactory?: ResponseFactory;
}

export async function handleDockerHubRequest(
  request: Request,
  options: DockerHubProxyOptions,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/") {
    return jsonResponse({
      service: "Docker Hub pull proxy",
      runtime: options.runtime,
      status: "ok",
      registry: "/v2/",
      authentication: "/token",
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return registryError(405, "UNSUPPORTED", "Only Docker image pull requests are supported", {
      Allow: "GET, HEAD",
    });
  }

  if (options.isRequestAllowed && !(await options.isRequestAllowed(request))) {
    return registryError(403, "DENIED", "This proxy does not allow requests from your address");
  }

  const fetcher = options.fetcher ?? fetch;
  const responseFactory = options.responseFactory ?? createStandardResponse;

  try {
    if (url.pathname === "/token" || url.pathname === "/auth/token") {
      const target = new URL(`${AUTH_ORIGIN}/token`);
      target.search = url.search;
      return await proxyRequest(
        request,
        target,
        url.origin,
        false,
        options.proxyHeader,
        fetcher,
        responseFactory,
      );
    }

    if (url.pathname === "/v2" || url.pathname.startsWith("/v2/")) {
      const target = new URL(`${REGISTRY_ORIGIN}${url.pathname}${url.search}`);
      return await proxyRequest(
        request,
        target,
        url.origin,
        true,
        options.proxyHeader,
        fetcher,
        responseFactory,
      );
    }

    return registryError(404, "NAME_UNKNOWN", "Only /v2/* and /token are available");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown upstream error";
    console.error("Docker Hub proxy request failed", {
      runtime: options.runtime,
      path: url.pathname,
      message,
    });
    return registryError(
      502,
      "UNAVAILABLE",
      "Docker Hub is temporarily unavailable through this proxy",
    );
  }
}

async function proxyRequest(
  request: Request,
  target: URL,
  publicOrigin: string,
  rewriteAuthChallenge: boolean,
  proxyHeader: string,
  fetcher: Fetcher,
  responseFactory: ResponseFactory,
): Promise<Response> {
  const upstreamHeaders = copyRequestHeaders(request.headers);
  const upstream = await fetchWithSafeRedirects(
    target,
    request.method,
    upstreamHeaders,
    fetcher,
  );
  const responseHeaders = copyResponseHeaders(upstream.headers);

  if (rewriteAuthChallenge) {
    const challenge = responseHeaders.get("www-authenticate");
    if (challenge) {
      responseHeaders.set(
        "www-authenticate",
        rewriteDockerAuthRealm(challenge, publicOrigin),
      );
    }
  }

  responseHeaders.set("x-docker-proxy", proxyHeader);

  return responseFactory(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function fetchWithSafeRedirects(
  initialUrl: URL,
  method: string,
  initialHeaders: Headers,
  fetcher: Fetcher,
): Promise<Response> {
  let currentUrl = initialUrl;
  let currentHeaders = initialHeaders;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetcher(currentUrl, {
      method,
      headers: currentHeaders,
      redirect: "manual",
      cache: "no-store",
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    if (redirectCount === MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new Error("Docker Hub redirect limit exceeded");
    }

    const nextUrl = new URL(location, currentUrl);
    if (!isAllowedUpstream(nextUrl)) {
      await response.body?.cancel();
      throw new Error(`Docker Hub redirected to a disallowed host: ${nextUrl.hostname}`);
    }

    if (nextUrl.origin !== currentUrl.origin) {
      currentHeaders = new Headers(currentHeaders);
      currentHeaders.delete("authorization");
      currentHeaders.delete("cookie");
    }

    await response.body?.cancel();
    currentUrl = nextUrl;
  }

  throw new Error("Unreachable redirect state");
}

function copyRequestHeaders(source: Headers): Headers {
  const headers = new Headers();

  for (const [name, value] of source) {
    const lowerName = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      lowerName === "host" ||
      lowerName === "forwarded" ||
      lowerName.startsWith("cf-") ||
      lowerName.startsWith("x-forwarded-")
    ) {
      continue;
    }
    headers.append(name, value);
  }

  return headers;
}

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers();

  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      headers.append(name, value);
    }
  }

  return headers;
}

function rewriteDockerAuthRealm(challenge: string, publicOrigin: string): string {
  return challenge.replace(
    /realm="https:\/\/auth\.docker\.io\/token(?:\?[^\"]*)?"/i,
    `realm="${publicOrigin}/token"`,
  );
}

function isAllowedUpstream(url: URL): boolean {
  if (url.protocol !== "https:") {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "registry-1.docker.io" ||
    hostname === "auth.docker.io" ||
    hostname === "production.cloudflare.docker.com" ||
    hostname.endsWith(".docker.io") ||
    hostname.endsWith(".docker.com") ||
    /^docker-images(?:-prod)?\.[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(hostname)
  );
}

function createStandardResponse(body: BodyInit | null, init: ResponseInit): Response {
  return new Response(body, init);
}

function jsonResponse(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}

function registryError(
  status: number,
  code: string,
  message: string,
  extraHeaders?: HeadersInit,
): Response {
  return jsonResponse({ errors: [{ code, message }] }, status, extraHeaders);
}

export const testing = {
  isAllowedUpstream,
  rewriteDockerAuthRealm,
};
