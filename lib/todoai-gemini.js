const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const PROVIDER_ORDER = ['gemini', 'qwen', 'deepseek'];
const MAX_PRIMARY_ATTEMPTS = 2;
const TOTAL_BUDGET_MS = 8_500;
const ATTEMPT_TIMEOUT_MS = 2_600;

/**
 * One server-side gateway for Todo AI.
 * Gemini is primary; Qwen and DeepSeek are OpenAI-compatible fallbacks.
 * Provider keys are intentionally TodoAI-specific to keep QiYue usage separate.
 */
export async function fetchTodoAI({ model, apiKey, body, route }) {
  const startedAt = Date.now();
  const providers = resolveProviders({ model, apiKey });
  if (!providers.length) throw new Error('no_todoai_provider_configured');

  let lastFailure = 'unknown';
  for (const provider of providers) {
    const attempts = provider.name === 'gemini' ? MAX_PRIMARY_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
      if (remaining < 250) break;
      const result = await attemptProvider({ provider, body, route, attempt, startedAt, remaining });
      if (result.response) {
        if (result.response.ok) return withProviderHeaders(result.response, provider);
        lastFailure = `status_${result.response.status}`;
        if (!result.retryable) return result.response;
        result.response.body?.cancel?.();
      } else {
        lastFailure = result.reason || 'network_error';
      }
      if (attempt < attempts && Date.now() - startedAt + 180 < TOTAL_BUDGET_MS) await wait(180);
    }
    if (provider.name !== providers[providers.length - 1].name && Date.now() < startedAt + TOTAL_BUDGET_MS) {
      console.info(`[todoai/${route}] provider_fallback from=${provider.name} reason=${lastFailure} totalMs=${Date.now() - startedAt}`);
    }
  }
  throw new Error(`todoai_provider_chain_failed:${lastFailure}`);
}

function resolveProviders({ model, apiKey }) {
  const configured = {
    gemini: apiKey ? {
      name: 'gemini',
      model: model || process.env.TODOAI_GEMINI_MODEL || 'gemini-2.5-flash-lite',
      apiKey,
    } : null,
    qwen: process.env.TODOAI_QWEN_API_KEY ? {
      name: 'qwen',
      model: process.env.TODOAI_QWEN_MODEL || 'qwen-plus',
      apiKey: process.env.TODOAI_QWEN_API_KEY,
      baseUrl: (process.env.TODOAI_QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
      visionModel: process.env.TODOAI_QWEN_VISION_MODEL || 'qwen-vl-plus',
    } : null,
    deepseek: process.env.TODOAI_DEEPSEEK_API_KEY ? {
      name: 'deepseek',
      model: process.env.TODOAI_DEEPSEEK_MODEL || 'deepseek-chat',
      apiKey: process.env.TODOAI_DEEPSEEK_API_KEY,
      baseUrl: (process.env.TODOAI_DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
    } : null,
  };
  const requested = String(process.env.TODOAI_PROVIDER_ORDER || PROVIDER_ORDER.join(','))
    .split(',').map((value) => value.trim().toLowerCase()).filter((value) => PROVIDER_ORDER.includes(value));
  const order = requested.length ? requested : PROVIDER_ORDER;
  return order.map((name) => configured[name]).filter(Boolean);
}

async function attemptProvider({ provider, body, route, attempt, startedAt, remaining }) {
  const attemptStartedAt = Date.now();
  const timeoutMs = Math.max(250, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = provider.name === 'gemini'
      ? buildGeminiRequest(provider, body)
      : buildOpenAIRequest(provider, body);
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    const raw = await response.text().catch(() => '');
    const normalized = response.ok ? normalizeProviderResponse(provider, raw) : null;
    const finalResponse = response.ok && !normalized
      ? new Response(JSON.stringify({ error: 'invalid_model_output' }), { status: 502, headers: { 'Content-Type': 'application/json' } })
      : response.ok
        ? new Response(JSON.stringify(normalized), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
        : new Response(raw || JSON.stringify({ error: 'provider_request_failed' }), { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json' } });
    const retryable = !response.ok && RETRYABLE_STATUS.has(response.status);
    console.info(`[todoai/${route}] provider=${provider.name} model=${provider.model} status=${response.status} attempt=${attempt} retryable=${retryable} latencyMs=${Date.now() - attemptStartedAt} totalMs=${Date.now() - startedAt}`);
    return { response: finalResponse, retryable };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : 'network_error';
    console.warn(`[todoai/${route}] provider=${provider.name} model=${provider.model} reason=${reason} attempt=${attempt} latencyMs=${Date.now() - attemptStartedAt} totalMs=${Date.now() - startedAt}`);
    return { reason, retryable: true };
  } finally {
    clearTimeout(timeout);
  }
}

function buildGeminiRequest(provider, body) {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'X-goog-api-key': provider.apiKey },
    body,
  };
}

function buildOpenAIRequest(provider, body) {
  const system = body?.systemInstruction?.parts?.map((part) => part.text || '').join('\n') || '';
  const parts = body?.contents?.flatMap((content) => content.parts || []) || [];
  const userContent = parts.map((part) => {
    if (part.text) return { type: 'text', text: part.text };
    if (part.inlineData && provider.name === 'qwen') {
      return { type: 'image_url', image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } };
    }
    return { type: 'text', text: '[附件图片未能由该备用模型读取，请根据文字继续处理。]' };
  });
  const schema = body?.generationConfig?.responseSchema;
  const schemaHint = schema ? `\nReturn only valid JSON matching this schema:\n${JSON.stringify(schema)}` : '';
  const messages = [
    { role: 'system', content: system + schemaHint },
    { role: 'user', content: userContent.length === 1 && userContent[0].type === 'text' ? userContent[0].text : userContent },
  ];
  const hasImage = userContent.some((part) => part.type === 'image_url');
  const selectedModel = hasImage && provider.visionModel ? provider.visionModel : provider.model;
  return {
    url: `${provider.baseUrl}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: { model: selectedModel, messages, temperature: body?.generationConfig?.temperature ?? 0.2, max_tokens: 1400, response_format: { type: 'json_object' } },
  };
}

function normalizeProviderResponse(provider, raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  let text = provider.name === 'gemini'
    ? data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || ''
    : data.choices?.[0]?.message?.content || '';
  if (Array.isArray(text)) text = text.map((part) => part.text || '').join('');
  text = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return { candidates: [{ content: { parts: [{ text: JSON.stringify(JSON.parse(text)) }] } }] }; } catch { return null; }
}

function withProviderHeaders(response, provider) {
  const headers = new Headers(response.headers);
  headers.set('x-todoai-provider', provider.name);
  headers.set('x-todoai-model', provider.model);
  return new Response(response.body, { status: response.status, headers });
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
