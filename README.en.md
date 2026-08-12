# Docker Hub Proxy on Cloudflare Workers

English | [简体中文](README.md)

This is a pull-only (`GET` / `HEAD`) reverse proxy for the Docker Registry V2 API. It:

- Streams `/v2/*` requests to `registry-1.docker.io`;
- Rewrites Docker Hub's authentication endpoint to the Worker's `/token` endpoint and proxies authentication requests through the Worker;
- Follows redirects to Docker's official CDN inside the Worker so clients do not connect directly to layer download hosts;
- Preserves headers required by Docker clients, including `Range`, `Accept`, and `Authorization`;
- Removes credentials when following cross-origin CDN redirects to prevent Registry Bearer Token leakage;
- Optionally restricts access by client IP address or country/region.

Response bodies are forwarded as `ReadableStream`s, so complete image layers are never buffered in Worker memory. This project does not cache image layers or store Docker Hub credentials.

## Deployment

You need Node.js 20 LTS, 22 LTS, or 24+, and a Cloudflare account:

```bash
npm install
npx wrangler login
npm run deploy
```

After deployment, Wrangler prints a URL similar to `https://dhp.<your-subdomain>.workers.dev`. Because access to `workers.dev` may be unreliable on some networks, using a custom domain such as `docker.example.com` is recommended.

You can add a Custom Domain in the Worker's settings in the Cloudflare Dashboard, or add the following at the top level of `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "docker.example.com", "custom_domain": true }
]
```

Verify the Registry handshake first:

```bash
curl -i https://docker.example.com/v2/
```

A normal response is usually `401 Unauthorized`, with the `realm` in `WWW-Authenticate` pointing to:

```text
https://docker.example.com/token
```

## Docker Configuration

On Linux, edit `/etc/docker/daemon.json`:

```json
{
  "registry-mirrors": ["https://docker.example.com"]
}
```

Then restart Docker:

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
docker pull alpine:latest
```

For Docker Desktop, add the same `registry-mirrors` configuration under **Settings → Docker Engine**, then restart Docker Desktop.

You can also pull through the proxy explicitly without changing the daemon configuration:

```bash
docker pull docker.example.com/library/alpine:latest
docker pull docker.example.com/library/nginx:latest
docker pull docker.example.com/username/image-name:tag
```

After an explicit pull, the local image name includes the proxy domain. Use `docker tag` to rename it if needed.

## Private Images

The proxy does not store credentials. To pull a private Docker Hub image, log in to the proxy domain:

```bash
docker login docker.example.com
```

The Worker forwards the Basic credentials submitted by the Docker client to `/token` over HTTPS to `auth.docker.io`. The returned short-lived Bearer Token is then used to pull the image. Always use your own HTTPS domain and restrict access to the proxy.

## Optional Access Restrictions

The default deployment is a public proxy and may be scanned or abused. You can add regular variables at the top level of `wrangler.jsonc`:

```jsonc
"vars": {
  "ALLOWED_IPS": "203.0.113.10,203.0.113.11",
  "ALLOWED_COUNTRIES": "CN,HK"
}
```

- `ALLOWED_IPS` is a comma-separated list of exact public IP addresses; CIDR ranges are not supported;
- `ALLOWED_COUNTRIES` uses Cloudflare two-letter country/region codes;
- If both variables are configured, requests must satisfy both restrictions;
- An IP allowlist may be unsuitable for residential connections whose public IP address changes frequently.

For production use, consider configuring Cloudflare WAF and rate limiting as well. Cloudflare Access browser-based login flows are generally incompatible with Docker daemon Registry requests.

## Local Verification

```bash
npm run check
npm test
npm run deploy:dry-run
```

Run the Worker locally:

```bash
npm run dev
curl -i http://localhost:8787/v2/
```

## Limitations and Considerations

- This is a transport proxy, not a Registry pull-through cache with persistent storage. Every layer not found in Docker's local cache still passes through the Worker.
- It supports Docker Hub pulls only. It does not support pushes and is not an open proxy for arbitrary URLs.
- Usage remains subject to Docker Hub's fair-use and pull-rate policies. The proxy does not bypass account permissions, organization policies, or quotas.
- Availability of Cloudflare Workers, your domain, and its network route in mainland China is not guaranteed. Test the deployment from the network where it will be used.
- Publicly proxying large images consumes Workers requests and traffic allowances. Evaluate this against your Cloudflare plan.
