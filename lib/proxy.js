/* Gemini 纯净反向代理核心逻辑（由 api/gemini.js 与 api/gemini/[...all].js 共用）
   区域固定美东 iad1，出站不带任何客户端来源 IP 头，避免 Google 地区限制。 */

const UPSTREAM_BASE = 'https://generativelanguage.googleapis.com';

export async function proxyHandler(req) {
  const started = Date.now();
  const token = process.env.PROXY_TOKEN;
  if (token && req.headers['x-qiyue-token'] !== token) {
    console.log(`[proxy] ${Date.now() - started}ms 403 forbidden (token mismatch)`);
    return new Response('forbidden', { status: 403 });
  }

  /* Vercel Node 函数里 req.url 是相对路径，必须补 base 再解析 */
  const host = req.headers['host'] || 'localhost';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const url = new URL(req.url || '/', `${protocol}://${host}`);
  const path = url.pathname.replace(/^\/api\/gemini/, '') || '/';

  /* 裸访问 /api/gemini（浏览器或误配置探测）时直接快速响应，
     不要转发 Google 根路径——空 GET 不带 API Key 会挂起直到超时 */
  if (path === '/') {
    return new Response(
      JSON.stringify({
        ok: true,
        service: 'qiyue-gemini-proxy',
        upstream: UPSTREAM_BASE,
        usage: 'POST /api/gemini/v1beta/models/{model}:generateContent',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const target = UPSTREAM_BASE + path + (url.search || '');
  const headers = {};
  if (req.headers['x-goog-api-key']) headers['X-goog-api-key'] = req.headers['x-goog-api-key'];
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

  const method = (req.method || 'GET').toUpperCase();
  let body;
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }

  try {
    const upstream = await fetch(target, { method, headers, body });
    console.log(`[proxy] ${method} ${path} -> ${upstream.status} in ${Date.now() - started}ms`);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'text/plain',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.log(`[proxy] ${method} ${path} FAILED after ${Date.now() - started}ms: ${msg}`);
    return new Response(
      JSON.stringify({ ok: false, error: msg, path, tookMs: Date.now() - started }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
