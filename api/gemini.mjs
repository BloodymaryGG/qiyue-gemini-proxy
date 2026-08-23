/* Gemini 纯净反向代理（Vercel 部署，区域固定美东）
   用途：栖月主站（Cloudflare）请求 Gemini 时，先经过本代理，
   代理在 Google 支持的区域出站，且不携带任何客户端来源 IP 头。
   部署：vercel deploy（区域配置见下方 config.regions = ['iad1']） */
export default async function handler(req) {
  /* 防滥用：设置了 PROXY_TOKEN 后，必须携带 X-Qiyue-Token 才放行 */
  const token = process.env.PROXY_TOKEN;
  if (token && req.headers['x-qiyue-token'] !== token) {
    return new Response('forbidden', { status: 403 });
  }
  const url = new URL(req.url || 'http://local');
  const path = url.pathname.replace(/^\/api\/gemini/, '') || '/';
  const target = 'https://generativelanguage.googleapis.com' + path + (url.search || '');

  const headers = {};
  if (req.headers['x-goog-api-key']) headers['X-goog-api-key'] = req.headers['x-goog-api-key'];
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

  const upstream = await fetch(target, {
    method: req.method || 'GET',
    headers,
    body: ['POST', 'PUT', 'PATCH'].includes((req.method || '').toUpperCase())
      ? await req.arrayBuffer()
      : undefined,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'text/plain',
      'Cache-Control': 'no-store',
    },
  });
}

export const config = {
  runtime: 'nodejs',
  regions: ['iad1'], // 美东（Google Gemini API 支持区域）
};
