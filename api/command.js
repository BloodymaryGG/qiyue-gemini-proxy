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
    const language = String(body?.language || '').startsWith('zh') ? 'zh-Hans' : 'en';
    const outputLanguage = language === 'zh-Hans' ? 'Simplified Chinese' : 'English';
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
        systemInstruction: { parts: [{ text: `You are TodoAI's AI task coordinator. The current server time is ${nowIso}; resolve relative dates from this time and output dates as ISO 8601 with a Z timezone. Assess every incomplete task with urgencyScore 0-100 using deadline, impact, dependencies, procrastination risk, and estimated duration. urgencyLabel must be one of ${language === 'zh-Hans' ? '紧急, 重要, 普通, 可稍后' : 'Urgent, Important, Normal, Can Wait'}. Explain the basis in reason, give a nextStep doable within 15-30 minutes, and suggest an appropriate reminder time. Existing tasks must use their exact provided id. You may propose create, update, complete, or delete actions; new tasks use taskID new. If the user only asks a question or requests advice, actions must be empty. Every batch change, reschedule, completion, or deletion requires requiresConfirmation=true; never claim an action was already applied. Keep reply concise. Write all user-facing fields in ${outputLanguage}. Output only JSON matching the schema.` }] },
        contents: [{ role: 'user', parts: [{ text: `${language === 'zh-Hans' ? '用户指令' : 'User request'}: ${message}\n\n${language === 'zh-Hans' ? '当前任务列表' : 'Current tasks'} (JSONL):\n${context || (language === 'zh-Hans' ? '暂无任务' : 'No tasks')}` }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: COMMAND_SCHEMA },
      }),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return send(res, { error: 'gemini_request_failed' }, upstream.status >= 500 ? 502 : upstream.status);
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    const result = JSON.parse(text);
    const validIDs = new Set(tasks.map((task) => String(task.id || '')));
    result.reply = String(result.reply || (language === 'zh-Hans' ? '我理解了你的需求，但暂时没有需要修改的任务。' : 'I understand your request, but there are no tasks to change right now.')).trim();
    result.actions = Array.isArray(result.actions) ? result.actions.filter((action) => {
      const type = String(action.type || '');
      return ['create', 'update', 'complete', 'delete'].includes(type) && (action.taskID === 'new' || validIDs.has(String(action.taskID)));
    }).slice(0, 20).map((action) => ({
      type: action.type, taskID: String(action.taskID), title: String(action.title || '').trim(), notes: String(action.notes || ''),
      dueDate: action.dueDate || null, reminderDate: action.reminderDate || null,
      priority: ['low', 'normal', 'high'].includes(action.priority) ? action.priority : 'normal',
      estimatedMinutes: Math.min(480, Math.max(5, Number(action.estimatedMinutes) || 30)), reason: String(action.reason || (language === 'zh-Hans' ? '根据你的指令调整' : 'Adjusted based on your request')),
    })) : [];
    result.focusTaskIDs = Array.isArray(result.focusTaskIDs) ? result.focusTaskIDs.filter((id) => validIDs.has(String(id))).slice(0, 5) : [];
    const urgencyLabels = language === 'zh-Hans' ? ['紧急', '重要', '普通', '可稍后'] : ['Urgent', 'Important', 'Normal', 'Can Wait'];
    result.assessments = Array.isArray(result.assessments) ? result.assessments.filter((item) => validIDs.has(String(item.taskID))).slice(0, 80).map((item) => ({
      taskID: String(item.taskID), urgencyScore: Math.min(100, Math.max(0, Number(item.urgencyScore) || 50)),
      urgencyLabel: urgencyLabels.includes(item.urgencyLabel) ? item.urgencyLabel : urgencyLabels[2],
      reason: String(item.reason || (language === 'zh-Hans' ? '根据截止时间和任务影响综合判断' : 'Based on the deadline and expected impact')), nextStep: String(item.nextStep || (language === 'zh-Hans' ? '先完成一个最小步骤' : 'Complete one small step first')), suggestedReminderDate: item.suggestedReminderDate || null,
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
