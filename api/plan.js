const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    dueDate: { type: 'string' },
    reminderDate: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    estimatedMinutes: { type: 'integer' },
    subtasks: { type: 'array', items: { type: 'string' } },
    urgencyScore: { type: 'integer' },
    urgencyLabel: { type: 'string' },
    aiReason: { type: 'string' },
    nextStep: { type: 'string' },
  },
  required: ['title', 'dueDate', 'reminderDate', 'priority', 'estimatedMinutes', 'subtasks', 'urgencyScore', 'urgencyLabel', 'aiReason', 'nextStep'],
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
    const language = String(body?.language || '').startsWith('zh') ? 'zh-Hans' : 'en';
    const outputLanguage = language === 'zh-Hans' ? 'Simplified Chinese' : 'English';
    const attachment = body?.attachment;
    if ((!input && !attachment) || input.length > 2000) return send(res, { error: 'invalid_input' }, 400);
    if (attachment && (!attachment.data || !attachment.mimeType || String(attachment.data).length > 12_000_000)) return send(res, { error: 'invalid_attachment' }, 400);
    const model = process.env.TODOAI_GEMINI_MODEL || 'gemini-2.5-flash-lite';
    const nowIso = new Date().toISOString();
    const parts = [];
    if (input) parts.push({ text: input });
    if (attachment) {
      if (attachment.mimeType.startsWith('text/')) {
        const attachmentLabel = language === 'zh-Hans' ? `附件 ${attachment.filename || '文件'} 的内容` : `Contents of attachment ${attachment.filename || 'file'}`;
        parts.push({ text: `${attachmentLabel}:\n${Buffer.from(attachment.data, 'base64').toString('utf8').slice(0, 40000)}` });
      } else {
        parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
      }
    }
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `You are a task-planning assistant. The current server time is ${nowIso}. Resolve relative dates from this time and never use a past year. Return all dates as ISO 8601 with a Z timezone, for example 2026-09-14T09:00:00Z; return an empty string when a date cannot be inferred. Generate the task and assess urgencyScore from 0-100, urgencyLabel, aiReason, and a nextStep doable within 15-30 minutes. Use only the user's input. Write title, subtasks, urgencyLabel, aiReason, and nextStep in ${outputLanguage}. The urgencyLabel must be one of ${language === 'zh-Hans' ? '紧急, 重要, 普通, 可稍后' : 'Urgent, Important, Normal, Can Wait'}. Output must match the JSON Schema.` }] },
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
    plan.title = String(plan.title || '').trim() || input || attachment?.filename || (language === 'zh-Hans' ? '处理附件' : 'Process attachment');
    plan.priority = ['low', 'normal', 'high'].includes(plan.priority) ? plan.priority : 'normal';
    plan.estimatedMinutes = Math.min(480, Math.max(5, Number(plan.estimatedMinutes) || 30));
    plan.subtasks = Array.isArray(plan.subtasks) ? plan.subtasks.filter((item) => String(item).trim()).slice(0, 8) : [];
    plan.urgencyScore = Math.min(100, Math.max(0, Number(plan.urgencyScore) || 50));
    const urgencyLabels = language === 'zh-Hans' ? ['紧急', '重要', '普通', '可稍后'] : ['Urgent', 'Important', 'Normal', 'Can Wait'];
    plan.urgencyLabel = urgencyLabels.includes(plan.urgencyLabel) ? plan.urgencyLabel : urgencyLabels[2];
    plan.aiReason = String(plan.aiReason || (language === 'zh-Hans' ? '根据任务截止时间和影响综合判断' : 'Based on the deadline and expected impact'));
    plan.nextStep = String(plan.nextStep || (language === 'zh-Hans' ? '先完成一个最小可执行步骤' : 'Complete one small actionable step first'));
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
