import {
  type CloudflareEnv,
  type CloudflareRequest,
  createCloudflareResponse,
  isClientAllowed,
} from "./cloudflare";
import { handleDockerHubRequest, testing } from "./proxy";

export default {
  fetch(request: CloudflareRequest, env: CloudflareEnv): Promise<Response> {
    return handleDockerHubRequest(request, {
      runtime: "Cloudflare Workers",
      proxyHeader: "cloudflare-worker",
      isRequestAllowed: () => isClientAllowed(request, env),
      responseFactory: createCloudflareResponse,
    });
  },
};

export { testing };
