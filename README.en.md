# Docker Hub Edge Pull Proxy (Cloudflare Pages)

English | [简体中文](README.md)

This is a pull-only (`GET` / `HEAD`) Docker Registry V2 reverse proxy deployed on Cloudflare Pages Functions. A Cloudflare Workers entrypoint is retained, while `pages.dev` is the default deployment target.

The proxy:

- Streams `/v2/*` requests to `registry-1.docker.io`;
- Rewrites Docker Hub authentication challenges to the proxy's own `/token` endpoint;
- Follows redirects to Docker's official CDN inside the edge function;
- Preserves Docker client headers such as `Range`, `Accept`, and `Authorization`;
- Removes credentials on cross-origin redirects to prevent Registry Bearer Token leakage;
- Optionally restricts access by client IP address or country/region.

Response bodies are forwarded as `ReadableStream`s, so complete image layers are never buffered in memory. The project does not cache image layers or store Docker Hub credentials.

## Deploy to Pages with GitHub Actions

### 1. Create the Cloudflare Pages project

The Pages project name must match `name` in `wrangler.jsonc`, currently `dhpc`. Create it once:

```bash
npm install
npx wrangler login
npx wrangler pages project create dhpc --production-branch main
```

Alternatively, create a **Direct Upload** Pages project named `dhpc` in the Cloudflare Dashboard and set its production branch to `main`.

The production URL assigned to the current project is:

```text
https://dhpc.pages.dev
```

Cloudflare may add a suffix to the `pages.dev` subdomain, so it may differ from the project name. When creating your own project, use the URL printed by Wrangler or shown in the Pages dashboard and replace the domain in the examples below.

### 2. Create a Cloudflare API token

In the Cloudflare Dashboard, open **My Profile → API Tokens → Create Token → Custom token** and grant:

```text
Account → Cloudflare Pages → Edit
```

Limit Account Resources to the Cloudflare account that will host the project.

### 3. Add GitHub Actions secrets

Open the GitHub repository and go to:

```text
Settings → Secrets and variables → Actions → New repository secret
```

Add these repository secrets:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | The API token created above |

Do not place these values in the source code, `wrangler.jsonc`, or GitHub Variables.

### 4. Trigger deployment

`.github/workflows/deploy-pages.yml` runs whenever code is pushed to `main`. It installs dependencies, type-checks the code, runs tests, and uploads both `public` and the Pages Functions to Cloudflare Pages.

You can also run it manually from **Actions → Deploy Cloudflare Pages → Run workflow**.

## Verify the deployment

Check the health endpoint:

```bash
curl -i https://dhpc.pages.dev/
```

It should return `200` with JSON containing:

```json
{"service":"Docker Hub pull proxy","runtime":"Cloudflare Pages Functions","status":"ok"}
```

Check the Registry handshake:

```bash
curl -i https://dhpc.pages.dev/v2/
```

A normal response is usually `401 Unauthorized`, with the `realm` in `WWW-Authenticate` pointing to:

```text
https://dhpc.pages.dev/token
```

Finally, pull a small image:

```bash
docker pull dhpc.pages.dev/library/alpine:latest
```

## Configure Docker as a registry mirror

On Linux, edit `/etc/docker/daemon.json`:

```json
{
  "registry-mirrors": ["https://dhpc.pages.dev"]
}
```

Then restart Docker:

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
docker pull alpine:latest
```

For Docker Desktop, add the same `registry-mirrors` setting under **Settings → Docker Engine**, then restart Docker Desktop.

## Private images

The proxy does not store credentials. To pull a private Docker Hub image, log in to the proxy domain:

```bash
docker login dhpc.pages.dev
```

The Docker client sends Basic credentials to `/token`; the proxy forwards them over HTTPS to `auth.docker.io`, and the returned short-lived Bearer Token is then used for image pulls.

## Optional access restrictions

The default deployment is public and may be scanned or abused. Add these values at the top level of `wrangler.jsonc` if needed:

```jsonc
"vars": {
  "ALLOWED_IPS": "203.0.113.10,203.0.113.11",
  "ALLOWED_COUNTRIES": "CN,HK"
}
```

- `ALLOWED_IPS` is a comma-separated list of exact public IP addresses; CIDR ranges are not supported;
- `ALLOWED_COUNTRIES` uses Cloudflare two-letter country/region codes;
- If both variables are configured, requests must satisfy both restrictions;
- Commit changes to `main`; GitHub Actions deploys the configuration with the code.

For production use, consider Cloudflare WAF and rate limiting. Cloudflare Access browser login flows are generally incompatible with Docker daemon Registry requests.

## Local verification

```bash
npm install
npm run check
npm test
npm run dev
```

The local Pages URL is usually `http://localhost:8788`:

```bash
curl -i http://localhost:8788/
curl -i http://localhost:8788/v2/
```

## Optional Worker deployment

The Worker configuration remains available in `wrangler.worker.jsonc`:

```bash
npm run dev:worker
npm run deploy:worker:dry-run
npm run deploy:worker
```

## Limitations and considerations

- This is a transport proxy, not a Registry pull-through cache with persistent storage. Every layer not found in Docker's local cache still passes through Pages Functions.
- It supports Docker Hub pulls only. It does not support pushes and is not an open proxy for arbitrary URLs.
- Usage remains subject to Docker Hub fair-use and pull-rate policies. The proxy does not bypass account permissions, organization policies, or quotas.
- Availability of `pages.dev` and its network routes in mainland China is not guaranteed. Test from the network where it will be used.
- Publicly proxying large images consumes Cloudflare requests and traffic allowances. Evaluate this against your Cloudflare plan.
