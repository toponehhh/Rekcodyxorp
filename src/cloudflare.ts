export interface CloudflareEnv {
  /** Optional comma-separated exact client IP allowlist. */
  ALLOWED_IPS?: string;
  /** Optional comma-separated Cloudflare country-code allowlist, for example CN,HK. */
  ALLOWED_COUNTRIES?: string;
}

export type CloudflareRequest = Request & {
  cf?: {
    country?: string;
  };
};

export function isClientAllowed(
  request: CloudflareRequest,
  env: CloudflareEnv,
): boolean {
  const allowedIps = parseList(env.ALLOWED_IPS);
  if (allowedIps.length > 0) {
    const clientIp = request.headers.get("cf-connecting-ip") ?? "";
    if (!allowedIps.includes(clientIp)) {
      return false;
    }
  }

  const allowedCountries = parseList(env.ALLOWED_COUNTRIES).map((country) =>
    country.toUpperCase()
  );
  if (allowedCountries.length > 0) {
    const country = request.cf?.country?.toUpperCase() ?? "";
    if (!allowedCountries.includes(country)) {
      return false;
    }
  }

  return true;
}

export function createCloudflareResponse(
  body: BodyInit | null,
  init: ResponseInit,
): Response {
  return new Response(body, {
    ...init,
    encodeBody: "manual",
  });
}

function parseList(value: string | undefined): string[] {
  return value
    ? value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
    : [];
}
