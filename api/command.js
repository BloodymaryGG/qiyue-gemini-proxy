const COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    requiresConfirmation: { type: 'boolean' },
    actions: { type: 'array', items: { type: 'object', properties: {
      type: { type: 'string', enum: ['create', 'update', 'complete', 'delete'] },
      taskID: { type: 'string' }, title: { type: 'string' }, notes: { type: 'string' },
      dueDate: { type: 'string' }, reminderDate: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      estimatedMinutes: { type: 'integer' }, reason: { type: 'string' },
    }, required: ['type', 'taskID', 'title', 'notes', 'dueDate', 'reminderDate', 'priority', 'estimatedMinutes', 'reason'] } },
    focusTaskIDs: { type: 'array', items: { type: 'string' } },
    assessments: { type: 'array', items: { type: 'object', properties: {
      taskID: { type: 'string' }, urgencyScore: { type: 'integer' }, urgencyLabel: { type: 'string' },
      reason: { type: 'string' }, nextStep: { type: 'string' }, suggestedReminderDate: { type: 'string' },
    }, required: ['taskID', 'urgencyScore', 'urgencyLabel', 'reason', 'nextStep', 'suggestedReminderDate'] } },
  },
    required: ['reply', 'requiresConfirmation', 'actions', 'focusTaskIDs', 'assessments'],
};

const attempts = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;

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
    const message = String(body?.message || '').trim();
    const tasks = Array.isArray(body?.tasks) ? body.tasks.slice(0, 80) : [];
    if (!message || message.length > 2000) return send(res, { error: 'invalid_message' }, 400);
    const model = process.env.TODOAI_GEMINI_MODEL || 'gemini-2.5-flash-lite';
    const nowIso = new Date().toISOString();
    const context = tasks.map((task) => JSON.stringify({
      id: String(task.id || ''), title: String(task.title || ''), notes: String(task.notes || '').slice(0, 300),
      dueDate: task.dueDate || null, reminderDate: task.reminderDate || null,
      priority: task.priority || 'normal', isCompleted: !!task.isCompleted, estimatedMinutes: Number(task.estimatedMinutes) || 30,
    })).join('\n');
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `你是 TodoAI 的中文 AI 指挥官。当前服务器时间是 ${nowIso}，按这个时间理解今天和明天，日期输出 ISO 8601 带 Z。你必须先评估每个未完成任务：urgencyScore 0-100（综合截止时间、影响、依赖、拖延风险和预计耗时），urgencyLabel 只能是“紧急”“重要”“普通”“可稍后”，reason 要说清依据，nextStep 要给出 15-30 分钟内可执行的下一步；suggestedReminderDate 是你认为合适的提醒时间。已有任务只能使用给出的精确 id。你能提出 create/update/complete/delete 操作，新增任务的 taskID 固定为 new。用户只是在询问或要建议时 actions 为空。任何批量修改、改期、完成或删除都必须 requiresConfirmation=true；不要假装已经执行操作。reply 要简洁说明你理解了什么。只输出符合 JSON Schema 的 JSON。` }] },
        contents: [{ role: 'user', parts: [{ text: `用户指令：${message}\n\n当前任务列表（JSONL）：\n${context || '暂无任务'}` }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: COMMAND_SCHEMA },
      }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return send(res, { error: 'gemini_request_failed' }, upstream.status >= 500 ? 502 : upstream.status);
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    const result = JSON.parse(text);
    const validIDs = new Set(tasks.map((task) => String(task.id || '')));
    result.reply = String(result.reply || '我理解了你的需求，但暂时没有需要修改的任务。').trim();
    result.actions = Array.isArray(result.actions) ? result.actions.filter((action) => {
      const type = String(action.type || '');
      return ['create', 'update', 'complete', 'delete'].includes(type) && (action.taskID === 'new' || validIDs.has(String(action.taskID)));
    }).slice(0, 20).map((action) => ({
      type: action.type, taskID: String(action.taskID), title: String(action.title || '').trim(), notes: String(action.notes || ''),
      dueDate: action.dueDate || null, reminderDate: action.reminderDate || null,
      priority: ['low', 'normal', 'high'].includes(action.priority) ? action.priority : 'normal',
      estimatedMinutes: Math.min(480, Math.max(5, Number(action.estimatedMinutes) || 30)), reason: String(action.reason || '根据你的指令调整'),
    })) : [];
    result.focusTaskIDs = Array.isArray(result.focusTaskIDs) ? result.focusTaskIDs.filter((id) => validIDs.has(String(id))).slice(0, 5) : [];
    result.assessments = Array.isArray(result.assessments) ? result.assessments.filter((item) => validIDs.has(String(item.taskID))).slice(0, 80).map((item) => ({
      taskID: String(item.taskID), urgencyScore: Math.min(100, Math.max(0, Number(item.urgencyScore) || 50)),
      urgencyLabel: ['紧急', '重要', '普通', '可稍后'].includes(item.urgencyLabel) ? item.urgencyLabel : '普通',
      reason: String(item.reason || '根据截止时间和任务影响综合判断'), nextStep: String(item.nextStep || '先完成一个最小步骤'), suggestedReminderDate: item.suggestedReminderDate || null,
    })) : [];
    result.requiresConfirmation = result.actions.length > 0 ? true : !!result.requiresConfirmation;
    return send(res, result, 200);
  } catch (error) {
    console.warn('[todoai/command] request failed', error?.message || error);
    return send(res, { error: 'command_failed' }, 502);
  }
}

function send(res, value, status) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value));
}

export const config = { runtime: 'nodejs' };
