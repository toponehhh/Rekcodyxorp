import {
  type CloudflareEnv,
  type CloudflareRequest,
  createCloudflareResponse,
  isClientAllowed,
} from "../src/cloudflare";
import { handleDockerHubRequest } from "../src/proxy";

interface PagesContext {
  request: CloudflareRequest;
  env: CloudflareEnv;
}

/** Cloudflare Pages Functions optional catch-all route. */
export function onRequest(context: PagesContext): Promise<Response> {
  return handleDockerHubRequest(context.request, {
    runtime: "Cloudflare Pages Functions",
    proxyHeader: "cloudflare-pages",
    isRequestAllowed: () => isClientAllowed(context.request, context.env),
    responseFactory: createCloudflareResponse,
  });
}
