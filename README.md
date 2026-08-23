# Gemini Proxy (Vercel)

Cloudflare 边缘（香港节点）直连 Google Gemini 会被地区限制拦截（`400 FAILED_PRECONDITION`）。
本仓库是一个部署在 **Vercel 美东（iad1）** 的纯净反向代理：把请求转发到
`generativelanguage.googleapis.com`，不携带任何客户端来源 IP 头。

## 部署

1. 在 Vercel（vercel.com）导入本仓库 → Deploy（区域已由代码锁定美东 iad1）
2. 部署后得到域名，例如 `https://gemini-proxy-xxxx.vercel.app`
3. （推荐）在 Vercel 项目 Settings → Environment Variables 添加：
   - `PROXY_TOKEN = 一串随机字符串`
4. 在栖月的 Cloudflare Pages 环境变量添加：
   - `GEMINI_PROXY_URL = https://gemini-proxy-xxxx.vercel.app/api/gemini`
   - `GEMINI_PROXY_TOKEN = <与 PROXY_TOKEN 相同>`
5. Cloudflare Pages 重新部署后生效；后台 LLM 面板 `gemini-proxy` 应转绿

## 说明

代理不做任何鉴权以外的逻辑，Gemini API Key 由调用方通过 `X-goog-api-key` 请求头透传。
