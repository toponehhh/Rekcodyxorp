# Docker Hub Cloudflare Workers 代理

[English](README.en.md) | 简体中文

这是一个只支持拉取（`GET` / `HEAD`）的 Docker Registry V2 反向代理。它会：

- 将 `/v2/*` 流式转发到 `registry-1.docker.io`；
- 将 Docker Hub 的认证地址改写到本 Worker 的 `/token`，认证请求也由 Worker 转发；
- 在 Worker 内跟随 Docker 官方 CDN 的重定向，避免客户端直连镜像层下载地址；
- 保留 `Range`、`Accept`、`Authorization` 等 Docker 客户端需要的请求头；
- 跨域跳转到 CDN 时移除认证信息，避免 Registry Bearer Token 泄露；
- 可选按客户端 IP 或国家/地区限制访问。

响应体直接使用 `ReadableStream` 转发，不会把整个镜像层读入 Worker 内存。本项目不缓存镜像层，也不会保存 Docker Hub 账号密码。

## 部署

需要 Node.js 20 LTS、22 LTS 或 24+，以及一个 Cloudflare 账号：

```bash
npm install
npx wrangler login
npm run deploy
```

部署成功后 Wrangler 会输出一个 `https://dhp.<你的子域>.workers.dev` 地址。国内网络下 `workers.dev` 本身可能不稳定，实际使用建议在 Cloudflare 中给 Worker 绑定自己的域名，例如 `docker.example.com`。

可以在 Cloudflare Dashboard 的 Worker 设置中添加 Custom Domain，也可以在 `wrangler.jsonc` 顶层加入：

```jsonc
"routes": [
  { "pattern": "docker.example.com", "custom_domain": true }
]
```

先检查 Registry 握手：

```bash
curl -i https://docker.example.com/v2/
```

正常结果通常是 `401 Unauthorized`，且 `WWW-Authenticate` 中的 `realm` 应指向：

```text
https://docker.example.com/token
```

## 配置 Docker

Linux 上编辑 `/etc/docker/daemon.json`：

```json
{
  "registry-mirrors": ["https://docker.example.com"]
}
```

然后重启 Docker：

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
docker pull alpine:latest
```

Docker Desktop 可在 **Settings → Docker Engine** 中加入相同的 `registry-mirrors` 配置并重启。

也可以不改守护进程，直接显式拉取：

```bash
docker pull docker.example.com/library/alpine:latest
docker pull docker.example.com/library/nginx:latest
docker pull docker.example.com/用户名/镜像名:标签
```

显式拉取后，本地镜像名会包含代理域名；需要时可再用 `docker tag` 改名。

## 私有镜像

代理不会存储凭据。需要拉取 Docker Hub 私有镜像时，对代理域名登录：

```bash
docker login docker.example.com
```

Docker 客户端提交给 `/token` 的 Basic 凭据会由 Worker 通过 HTTPS 转发给 `auth.docker.io`，获得的短期 Bearer Token 再用于拉取。请务必使用自己的 HTTPS 域名，并限制代理访问范围。

## 可选访问限制

默认部署是公开代理，可能被扫描和滥用。可以在 `wrangler.jsonc` 顶层添加普通变量：

```jsonc
"vars": {
  "ALLOWED_IPS": "203.0.113.10,203.0.113.11",
  "ALLOWED_COUNTRIES": "CN,HK"
}
```

- `ALLOWED_IPS` 是逗号分隔的精确公网 IP，不支持 CIDR；
- `ALLOWED_COUNTRIES` 使用 Cloudflare 两位国家/地区代码；
- 两项同时配置时，请求必须同时满足；
- 家庭宽带公网 IP 经常变化时，IP 白名单可能不适用。

生产使用还建议在 Cloudflare 上配置 WAF/速率限制。Cloudflare Access 的网页登录流程通常不兼容 Docker daemon 的 Registry 请求。

## 本地验证

```bash
npm run check
npm test
npm run deploy:dry-run
```

运行本地 Worker：

```bash
npm run dev
curl -i http://localhost:8787/v2/
```

## 边界与注意事项

- 这是传输代理，不是带持久存储的 Registry pull-through cache；每个未命中 Docker 本地缓存的层仍会经过 Worker。
- 只支持 Docker Hub，不支持推送，也不是任意 URL 的开放代理。
- 使用仍受 Docker Hub 公平使用和拉取速率政策约束；代理不会绕过账号权限、组织策略或配额。
- Cloudflare Workers、你的域名和线路在中国大陆的可用性不受本项目保证，部署后应从实际使用网络测试。
- 公开转发大镜像会消耗 Workers 请求与流量额度，请结合自己的 Cloudflare 套餐评估。
