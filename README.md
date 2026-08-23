# Gemini Proxy

Cloudflare 边缘（香港节点）直连 Google Gemini 会被地区限制拦截（`400 FAILED_PRECONDITION`）。
本仓库是一个纯净反向代理：把请求转发到
`generativelanguage.googleapis.com`，不携带任何客户端来源 IP 头。

主路由：`/api/gemini` 与 `/api/gemini/*`。

## Deno Deploy（推荐备选）

如果 Vercel 项目继续出现函数 504，可在 Deno Deploy 导入本仓库：

1. New Project → Import GitHub repository
2. 入口文件填写 `deno/main.ts`
3. 环境变量添加：
   - `PROXY_TOKEN = 一串随机字符串`
4. 部署后得到域名，例如 `https://qiyue-gemini-proxy.deno.dev`
5. 在栖月的 Cloudflare Pages 环境变量添加：
   - `GEMINI_PROXY_URL = https://qiyue-gemini-proxy.deno.dev/api/gemini`
   - `GEMINI_PROXY_TOKEN = <与 PROXY_TOKEN 相同>`
6. Cloudflare Pages 重新部署后生效；后台 LLM 面板 `gemini-proxy` 应转绿

裸访问 `/api/gemini` 会秒回健康 JSON，便于确认函数本体可用。

## Vercel

Vercel 的 `/api` 目录不支持 `[...catchAll]`，因此函数本体是静态文件
`api/proxy.js`，由 `vercel.json` 的 rewrites 把两个路径路由到它。

### 部署

1. 在 Vercel（vercel.com）导入本仓库 → Deploy
2. 部署后得到域名，例如 `https://gemini-proxy-xxxx.vercel.app`
3. （推荐）在 Vercel 项目 Settings → Environment Variables 添加：
   - `PROXY_TOKEN = 一串随机字符串`
4. 在栖月的 Cloudflare Pages 环境变量添加：
   - `GEMINI_PROXY_URL = https://gemini-proxy-xxxx.vercel.app/api/gemini`
   - `GEMINI_PROXY_TOKEN = <与 PROXY_TOKEN 相同>`
5. Cloudflare Pages 重新部署后生效；后台 LLM 面板 `gemini-proxy` 应转绿

## 说明

代理不做任何鉴权以外的逻辑，Gemini API Key 由调用方通过 `X-goog-api-key` 请求头透传。
