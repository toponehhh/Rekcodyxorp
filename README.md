# Docker Hub 边缘拉取代理（Cloudflare Pages）

[English](README.en.md) | 简体中文

这是一个部署在 Cloudflare Pages Functions 上、只允许拉取（`GET` / `HEAD`）的 Docker Registry V2 反向代理。代码也保留 Cloudflare Workers 入口，但默认部署目标是 `pages.dev`。

代理会：

- 将 `/v2/*` 流式转发到 `registry-1.docker.io`；
- 把 Docker Hub 的认证地址改写到代理自身的 `/token`；
- 在边缘函数内跟随 Docker 官方 CDN 重定向，避免客户端直接连接镜像层地址；
- 保留 `Range`、`Accept`、`Authorization` 等 Docker 客户端需要的请求头；
- 跨域跳转时移除认证信息，避免 Registry Bearer Token 泄露；
- 可选按客户端 IP 或国家/地区限制访问。

响应体使用 `ReadableStream` 转发，不会把整个镜像层读入内存。本项目不缓存镜像层，也不会保存 Docker Hub 账号密码。

## 通过 GitHub Actions 部署到 Pages

### 1. 在 Cloudflare 创建 Pages 项目

Pages 项目名必须与 `wrangler.jsonc` 中的 `name` 一致，当前为 `dhpc`。首次只需创建一次：

```bash
npm install
npx wrangler login
npx wrangler pages project create dhpc --production-branch main
```

也可以在 Cloudflare Dashboard 中创建名为 `dhpc` 的 **Direct Upload** Pages 项目，生产分支填写 `main`。

当前项目实际分配的生产地址为：

```text
https://dhpc.pages.dev
```

Cloudflare 分配的 `pages.dev` 子域名可能带有后缀，并不一定与项目名完全一致。自行创建项目时，请以 Wrangler 输出或 Pages 控制台中的地址为准，并替换以下示例中的域名。

### 2. 创建 Cloudflare API Token

在 Cloudflare Dashboard 的 **My Profile → API Tokens → Create Token → Custom token** 中创建令牌，权限设置为：

```text
Account → Cloudflare Pages → Edit
```

Account Resources 只选择要部署到的 Cloudflare 账号即可。

### 3. 添加 GitHub Actions Secrets

打开 GitHub 仓库：

```text
Settings → Secrets and variables → Actions → New repository secret
```

添加两个 Repository secret：

| 名称 | 值 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `CLOUDFLARE_API_TOKEN` | 上一步创建的 API Token |

不需要把这些值写进代码、`wrangler.jsonc` 或 GitHub Variables。

### 4. 触发部署

`.github/workflows/deploy-pages.yml` 会在代码推送到 `main` 时自动执行以下流程：

1. 安装依赖；
2. TypeScript 类型检查；
3. 运行测试；
4. 上传 `public` 和 Pages Functions 到 Cloudflare Pages。

也可以在 GitHub 的 **Actions → Deploy Cloudflare Pages → Run workflow** 中手工触发。

## 验证部署

先验证健康检查：

```bash
curl -i https://dhpc.pages.dev/
```

应返回 `200`，JSON 中包含：

```json
{"service":"Docker Hub pull proxy","runtime":"Cloudflare Pages Functions","status":"ok"}
```

再验证 Registry 握手：

```bash
curl -i https://dhpc.pages.dev/v2/
```

正常结果通常是 `401 Unauthorized`，且 `WWW-Authenticate` 中的 `realm` 应指向：

```text
https://dhpc.pages.dev/token
```

最后实际拉取一个小镜像：

```bash
docker pull dhpc.pages.dev/library/alpine:latest
```

## 配置 Docker 镜像加速

Linux 上编辑 `/etc/docker/daemon.json`：

```json
{
  "registry-mirrors": ["https://dhpc.pages.dev"]
}
```

然后重启 Docker：

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
docker pull alpine:latest
```

Docker Desktop 可在 **Settings → Docker Engine** 中加入相同配置并重启。

## 私有镜像

代理不会保存凭据。拉取 Docker Hub 私有镜像时，对代理域名登录：

```bash
docker login dhpc.pages.dev
```

Docker 客户端提交给 `/token` 的 Basic 凭据会通过 HTTPS 转发给 `auth.docker.io`，返回的短期 Bearer Token 再用于拉取。

## 可选访问限制

默认部署是公开代理，可能被扫描和滥用。可以在 `wrangler.jsonc` 顶层添加：

```jsonc
"vars": {
  "ALLOWED_IPS": "203.0.113.10,203.0.113.11",
  "ALLOWED_COUNTRIES": "CN,HK"
}
```

- `ALLOWED_IPS` 是逗号分隔的精确公网 IP，不支持 CIDR；
- `ALLOWED_COUNTRIES` 使用 Cloudflare 两位国家/地区代码；
- 两项同时配置时，请求必须同时满足；
- 修改后提交到 `main`，GitHub Actions 会把配置与代码一起部署。

生产使用还建议配置 Cloudflare WAF 和速率限制。Cloudflare Access 的网页登录流程通常不兼容 Docker daemon 的 Registry 请求。

## 本地验证

```bash
npm install
npm run check
npm test
npm run dev
```

本地 Pages 地址通常是 `http://localhost:8788`：

```bash
curl -i http://localhost:8788/
curl -i http://localhost:8788/v2/
```

## 可选：继续部署为 Worker

Worker 配置保存在 `wrangler.worker.jsonc`：

```bash
npm run dev:worker
npm run deploy:worker:dry-run
npm run deploy:worker
```

## 边界与注意事项

- 这是传输代理，不是带持久存储的 Registry pull-through cache；每个未命中 Docker 本地缓存的层仍会经过 Pages Functions。
- 只支持 Docker Hub 拉取，不支持推送，也不是任意 URL 的开放代理。
- 使用仍受 Docker Hub 公平使用和拉取速率政策约束；代理不会绕过账号权限、组织策略或配额。
- `pages.dev` 和实际线路在中国大陆的可用性不受本项目保证，部署后应从实际使用网络测试。
- 公开转发大镜像会消耗 Cloudflare 请求与流量额度，请结合自己的套餐评估。
