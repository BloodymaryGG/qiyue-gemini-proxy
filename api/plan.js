const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    dueDate: { type: 'string' },
    reminderDate: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    estimatedMinutes: { type: 'integer' },
    subtasks: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'dueDate', 'reminderDate', 'priority', 'estimatedMinutes', 'subtasks'],
};

const attempts = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, { error: 'method_not_allowed' }, 405);
  if (req.headers['x-ai-app'] !== 'todoai') return send(res, { error: 'app_header_required' }, 403);
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) return send(res, { error: 'rate_limited' }, 429);
  recent.push(now); attempts.set(ip, recent);
  const apiKey = process.env.TODOAI_GEMINI_API_KEY;
  if (!apiKey) return send(res, { error: 'todoai_model_not_configured' }, 503);
  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const input = String(body?.input || '').trim();
    const attachment = body?.attachment;
    if ((!input && !attachment) || input.length > 2000) return send(res, { error: 'invalid_input' }, 400);
    if (attachment && (!attachment.data || !attachment.mimeType || String(attachment.data).length > 8_000_000)) return send(res, { error: 'invalid_attachment' }, 400);
    const model = process.env.TODOAI_GEMINI_MODEL || 'gemini-2.5-flash-lite';
    const nowIso = new Date().toISOString();
    const parts = [];
    if (input) parts.push({ text: input });
    if (attachment) {
      if (attachment.mimeType.startsWith('text/')) {
        parts.push({ text: `附件 ${attachment.filename || '文件'} 的内容：\n${Buffer.from(attachment.data, 'base64').toString('utf8').slice(0, 40000)}` });
      } else {
        parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
      }
    }
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `你是待办事项规划助手。当前服务器时间是 ${nowIso}。相对日期（今天、明天、下周）必须以这个时间为基准计算；不要使用过去年份。所有日期必须输出 ISO 8601 且带 Z 时区，例如 2026-09-14T09:00:00Z；无法判断日期时返回空字符串。只根据用户输入生成计划，输出必须符合 JSON Schema。` }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA },
      }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.warn('[todoai/plan] Gemini rejected request', upstream.status, data.error?.message || 'upstream rejected request');
      return send(res, { error: 'gemini_request_failed', status: upstream.status }, upstream.status >= 500 ? 502 : upstream.status);
    }
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    const plan = JSON.parse(text);
    if (plan.dueDate === '') plan.dueDate = null;
    if (plan.reminderDate === '') plan.reminderDate = null;
    return send(res, { ...plan, model }, 200);
  } catch (error) {
    console.warn('[todoai/plan] request failed', error?.message || error);
    return send(res, { error: 'plan_failed' }, 502);
  }
}

function send(res, value, status) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

export const config = { runtime: 'nodejs' };
