const UPSTREAM_BASE = 'https://generativelanguage.googleapis.com';

function buildForwardQuery(url: URL) {
  const params = new URLSearchParams(url.search);
  params.delete('path');
  const s = params.toString();
  return s ? '?' + s : '';
}

function corsHeaders(contentType = 'application/json') {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  };
}

Deno.serve(async (request) => {
  const started = Date.now();
  const url = new URL(request.url);
  const token = Deno.env.get('PROXY_TOKEN');

  console.log(`[proxy] request ${request.method} ${url.pathname} at ${new Date().toISOString()}`);

  if (token && request.headers.get('x-qiyue-token') !== token) {
    console.log(`[proxy] ${Date.now() - started}ms 403 forbidden (token mismatch)`);
    return new Response('forbidden', { status: 403 });
  }

  let path = '';
  if (url.pathname.startsWith('/api/gemini')) {
    path = url.pathname.replace(/^\/api\/gemini/, '') || '/';
  } else {
    path = url.pathname || '/';
  }

  if (path === '/') {
    return Response.json({
      ok: true,
      service: 'qiyue-gemini-proxy',
      runtime: 'deno',
      upstream: UPSTREAM_BASE,
      usage: 'POST /api/gemini/v1beta/models/{model}:generateContent',
    });
  }

  if (!path.startsWith('/')) path = '/' + path;

  const target = UPSTREAM_BASE + path + buildForwardQuery(url);
  const headers = new Headers();
  const apiKey = request.headers.get('x-goog-api-key');
  const contentType = request.headers.get('content-type');
  if (apiKey) headers.set('X-goog-api-key', apiKey);
  if (contentType) headers.set('Content-Type', contentType);

  const method = request.method.toUpperCase();
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? request.body : undefined;

  try {
    const upstream = await fetch(target, { method, headers, body });
    console.log(`[proxy] ${method} ${path} -> ${upstream.status} in ${Date.now() - started}ms`);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: corsHeaders(upstream.headers.get('Content-Type') || 'text/plain'),
    });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    console.log(`[proxy] ${method} ${path} FAILED after ${Date.now() - started}ms: ${msg}`);
    return Response.json(
      { ok: false, error: msg, path, tookMs: Date.now() - started },
      { status: 502 },
    );
  }
});
