/* Gemini 纯净反向代理（Vercel Node 运行时，区域固定美东 iad1）
   用途：栖月主站（Cloudflare）请求 Gemini 时，先经过本代理，
   代理在 Google 支持的区域出站，且不携带任何客户端来源 IP 头。
   注意：使用 Node 运行时而非 Edge，是为了用 regions:['iad1'] 固定美东出口；
   Edge 函数无法固定区域，可能又回到香港出口被 Google 地区限制拦截。 */
export default async function handler(req) {
  /* 防滥用：设置了 PROXY_TOKEN 后，必须携带 X-Qiyue-Token 才放行 */
  const token = process.env.PROXY_TOKEN;
  if (token && req.headers['x-qiyue-token'] !== token) {
    return new Response('forbidden', { status: 403 });
  }
  /* Vercel Node 函数里 req.url 是相对路径，必须补 base 再解析 */
  const url = new URL(req.url || '/', 'https://local');
  const path = url.pathname.replace(/^\/api\/gemini/, '') || '/';
  const target = 'https://generativelanguage.googleapis.com' + path + (url.search || '');

  const headers = {};
  if (req.headers['x-goog-api-key']) headers['X-goog-api-key'] = req.headers['x-goog-api-key'];
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

  /* Vercel Node 请求对象没有 arrayBuffer()，手动把流读成 Buffer */
  let body;
  if (['POST', 'PUT', 'PATCH'].includes((req.method || '').toUpperCase())) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }

  const upstream = await fetch(target, {
    method: req.method || 'GET',
    headers,
    body,
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
