import { fetchTodoAI } from '../lib/todoai-gemini.js';
import { beginAIRequest, commitAIRequest, releaseAIRequest } from '../lib/access.js';

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    dueDate: { type: 'string' },
    reminderDate: { type: 'string' },
    timeType: { type: 'string', enum: ['start', 'deadline', 'reminder', 'relative', 'unknown'] },
    timeConfidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    needsClarification: { type: 'boolean' },
    clarificationQuestion: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'] },
    complexity: { type: 'string', enum: ['simple', 'complex'] },
    reason: { type: 'string' },
  },
    required: ['title', 'dueDate', 'reminderDate', 'timeType', 'timeConfidence', 'needsClarification', 'clarificationQuestion', 'priority', 'complexity', 'reason'],
};

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

/**
 * Todo AI's staged intelligence pipeline.
 *
 * create: one quota reservation, then intent -> plan. The client creates a
 * local shell first, so this endpoint may return a clarification instead of a
 * guessed date. reorganize is an explicit third-stage user action.
 */
export default async function handler(req, res) {
  const requestId = String(req.headers['x-vercel-id'] || 'unknown');
  const startedAt = Date.now();
  if (req.method !== 'POST') return send(res, { error: 'method_not_allowed' }, 405);
  if (req.headers['x-ai-app'] !== 'todoai') return send(res, { error: 'app_header_required' }, 403);
  if (!rateLimit(req)) return send(res, { error: 'rate_limited' }, 429);
  if (!hasProvider()) return send(res, { error: 'todoai_model_not_configured' }, 503);

  let quota;
  try {
    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const mode = body?.mode === 'reorganize' ? 'reorganize' : 'create';
    const language = String(body?.language || '').startsWith('zh') ? 'zh-Hans' : 'en';
    const outputLanguage = language === 'zh-Hans' ? 'Simplified Chinese' : 'English';
    const input = String(body?.input || '').trim();
    const attachment = body?.attachment;
    if (mode === 'create' && ((!input && !attachment) || input.length > 2000)) return send(res, { error: 'invalid_input' }, 400);
    if (attachment && (!attachment.data || !attachment.mimeType || String(attachment.data).length > 16_000_000)) return send(res, { error: 'invalid_attachment' }, 400);
    if (mode === 'reorganize' && (!body?.plan || !String(body?.preference || '').trim())) return send(res, { error: 'invalid_reorganize_input' }, 400);

    quota = await beginAIRequest(req);
    if (!quota.allowed) return send(res, quota.body, quota.status);
    console.info(JSON.stringify({ event: 'todoai_pipeline_start', requestId, mode, hasAttachment: Boolean(attachment) }));

    if (mode === 'reorganize') {
      const plan = await reorganize({ plan: body.plan, preference: String(body.preference).trim(), language, outputLanguage, now: body.now || new Date().toISOString() });
      await commitAIRequest(quota);
      console.info(JSON.stringify({ event: 'todoai_pipeline_done', requestId, stage: 'reorganized', durationMs: Date.now() - startedAt }));
      return send(res, { stage: 'reorganized', intent: intentFromPlan(plan), plan, requiresClarification: false, planConfirmationRequired: false, usage: quota.usage }, 200);
    }

    const intent = await interpret({ input, attachment, language, outputLanguage, now: body.now || new Date().toISOString(), deterministic: body.deterministic });
    if (intent.needsClarification) {
      await commitAIRequest(quota);
      console.info(JSON.stringify({ event: 'todoai_pipeline_done', requestId, stage: 'intent', clarification: true, durationMs: Date.now() - startedAt }));
      return send(res, {
        stage: 'intent',
        intent,
        plan: null,
        requiresClarification: true,
        usage: quota.usage,
      }, 200);
    }

    const plan = await generatePlan({ input, intent, language, outputLanguage, now: body.now || new Date().toISOString() });
    await commitAIRequest(quota);
    console.info(JSON.stringify({ event: 'todoai_pipeline_done', requestId, stage: 'plan', clarification: false, durationMs: Date.now() - startedAt }));
    return send(res, { stage: 'plan', intent, plan, requiresClarification: false, planConfirmationRequired: intent.complexity === 'complex', usage: quota.usage }, 200);
  } catch (error) {
    if (quota) await releaseAIRequest(quota);
    console.warn(JSON.stringify({ event: 'todoai_pipeline_failed', requestId, error: error?.message || String(error), durationMs: Date.now() - startedAt }));
    return send(res, { error: 'pipeline_failed' }, 502);
  }
}

async function interpret({ input, attachment, language, outputLanguage, now, deterministic }) {
  const hardFacts = deterministic && (deterministic.dueDate || deterministic.reminderDate)
    ? `\nDeterministic local parser facts (these are authoritative and MUST NOT be changed): ${JSON.stringify({ dueDate: deterministic.dueDate || null, reminderDate: deterministic.reminderDate || deterministic.dueDate || null })}`
    : '';
  const result = await structuredCall({
    route: 'pipeline-intent',
    schema: INTENT_SCHEMA,
    system: `You are Todo AI's fast intent interpreter. Current time is ${now}. Return only JSON matching the schema. Understand natural language dates and times, but never invent a clock time when the user only said a vague period such as tomorrow afternoon, tonight, later, or this weekend. In those cases set needsClarification=true, leave dueDate and reminderDate empty, and ask exactly one short question in ${outputLanguage}. Convert explicit relative time to absolute ISO 8601 UTC. Set timeType to start when the user describes when an activity should begin, deadline when they describe when it must be finished, reminder when they explicitly ask to be reminded, relative when the time is expressed as a relative duration such as one hour later, otherwise unknown. Remove scheduling words from title. Use ${outputLanguage} for title, clarificationQuestion, and reason.${hardFacts}`,
    user: input,
    attachment,
  });
  const value = normalizeIntent(result, input, deterministic);
  return value;
}

async function generatePlan({ input, intent, language, outputLanguage, now }) {
  const result = await structuredCall({
    route: 'pipeline-plan',
    schema: PLAN_SCHEMA,
    system: `You are Todo AI's completion-path planner. Current time is ${now}. Return only JSON matching the schema. The intent JSON below has already been time-validated; preserve its dueDate, reminderDate, title meaning, and priority. For simple tasks such as picking up a package, attending class, taking medicine, calling someone, or submitting one item, return an empty subtasks array, estimatedMinutes 0, and empty aiReason/nextStep. Only create a concise useful checklist for genuinely complex tasks. Write user-facing text in ${outputLanguage}. Intent: ${JSON.stringify(intent)}`,
    user: input,
  });
  return normalizePlan(result, intent, language);
}

async function reorganize({ plan, preference, language, outputLanguage, now }) {
  const result = await structuredCall({
    route: 'pipeline-reorganize',
    schema: PLAN_SCHEMA,
    system: `You are Todo AI's final plan editor. Current time is ${now}. Reorganize the existing plan according to the user's preference. Preserve explicit dates and reminders unless the preference clearly changes them. Return only JSON matching the schema, keep simple tasks simple, and write in ${outputLanguage}. Existing plan: ${JSON.stringify(plan)}`,
    user: preference,
  });
  return normalizePlan(result, plan, language);
}

async function structuredCall({ route, schema, system, user, attachment }) {
  const apiKey = process.env.TODOAI_GEMINI_API_KEY;
  const model = process.env.TODOAI_GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const upstream = await fetchTodoAI({
    model,
    apiKey,
    route,
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: attachmentParts(user, attachment) }],
      generationConfig: { temperature: 0.15, responseMimeType: 'application/json', responseSchema: schema },
    },
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(`provider_status_${upstream.status}`);
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return JSON.parse(String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
}

function attachmentParts(input, attachment) {
  const parts = [];
  if (input) parts.push({ text: input });
  if (!attachment) return parts;
  if (String(attachment.mimeType).startsWith('text/')) {
    parts.push({ text: `Attachment ${attachment.filename || 'file'}:\n${Buffer.from(attachment.data, 'base64').toString('utf8').slice(0, 40000)}` });
  } else {
    parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
  }
  return parts;
}

function normalizeIntent(value, input, deterministic) {
  const title = String(value?.title || '').trim() || input;
  const hasDeterministicTime = Boolean(deterministic?.dueDate || deterministic?.reminderDate);
  const vagueTime = hasVagueTime(input);
  const needsClarification = !hasDeterministicTime && (vagueTime || value?.needsClarification === true);
  return {
    title,
    dueDate: hasDeterministicTime ? (deterministic.dueDate || deterministic.reminderDate) : needsClarification ? null : emptyToNull(value?.dueDate),
    reminderDate: hasDeterministicTime ? (deterministic.reminderDate || deterministic.dueDate) : needsClarification ? null : emptyToNull(value?.reminderDate),
    timeType: normalizeTimeType(value?.timeType, input, hasDeterministicTime),
    timeConfidence: hasDeterministicTime ? 'high' : needsClarification ? 'low' : ['high', 'medium', 'low', 'none'].includes(value?.timeConfidence) ? value.timeConfidence : 'none',
    needsClarification,
    clarificationQuestion: needsClarification ? clarificationQuestion(input, value?.clarificationQuestion) : '',
    priority: ['low', 'normal', 'high'].includes(value?.priority) ? value.priority : 'normal',
    complexity: value?.complexity === 'complex' ? 'complex' : 'simple',
    reason: String(value?.reason || '').trim(),
  };
}

function normalizePlan(value, intent, language) {
  const labels = language === 'zh-Hans' ? ['紧急', '重要', '普通', '可稍后'] : ['Urgent', 'Important', 'Normal', 'Can Wait'];
  return {
    title: String(value?.title || intent.title).trim() || intent.title,
    dueDate: intent.dueDate || emptyToNull(value?.dueDate),
    reminderDate: intent.reminderDate || emptyToNull(value?.reminderDate),
    priority: ['low', 'normal', 'high'].includes(value?.priority) ? value.priority : intent.priority,
    estimatedMinutes: intent.complexity === 'simple' ? 0 : Math.min(480, Math.max(5, Number(value?.estimatedMinutes) || 30)),
    subtasks: intent.complexity === 'simple' ? [] : Array.isArray(value?.subtasks) ? value.subtasks.map((item) => String(item).trim()).filter(Boolean).slice(0, 8) : [],
    urgencyScore: Math.min(100, Math.max(0, Number(value?.urgencyScore) || (intent.priority === 'high' ? 80 : 50))),
    urgencyLabel: labels.includes(value?.urgencyLabel) ? value.urgencyLabel : labels[2],
    aiReason: intent.complexity === 'simple' ? '' : String(value?.aiReason || '').trim(),
    nextStep: intent.complexity === 'simple' ? '' : String(value?.nextStep || '').trim(),
  };
}

function intentFromPlan(plan) {
  return {
    title: plan.title,
    dueDate: plan.dueDate || null,
    reminderDate: plan.reminderDate || null,
    timeType: plan.reminderDate && plan.dueDate ? 'unknown' : 'unknown',
    timeConfidence: plan.dueDate || plan.reminderDate ? 'high' : 'none',
    needsClarification: false,
    clarificationQuestion: '',
    priority: plan.priority,
    complexity: plan.subtasks.length ? 'complex' : 'simple',
    reason: '',
  };
}
function normalizeTimeType(value, input, hasDeterministicTime) {
  const allowed = ['start', 'deadline', 'reminder', 'relative', 'unknown'];
  if (allowed.includes(value)) return value;
  const text = String(input || '');
  if (/(分钟后|小时后|天后|周后|一会儿后|稍后)/.test(text)) return 'relative';
  if (/(提醒我|叫我|别让我忘|不要忘)/.test(text)) return 'reminder';
  if (/(截止|交作业|交稿|完成|之前|前完成)/.test(text)) return 'deadline';
  if (hasDeterministicTime || /(上课|开始|做听力|学习|去|参加)/.test(text)) return 'start';
  return 'unknown';
}

function hasVagueTime(input) {
  const text = String(input || '');
  const hasDay = /(今天|明天|后天|今晚|明早|周[一二三四五六日]|星期[一二三四五六日])/.test(text);
  const hasPeriod = /(凌晨|早上|上午|中午|下午|晚上|今晚|明早|晚点|稍后)/.test(text);
  const hasClock = /(?:凌晨|早上|上午|中午|下午|晚上|今晚|明早)?\s*(?:[0-9]{1,2}|[一二两三四五六七八九十百]+)\s*(?:点|时|:\s*[0-9]{1,2})/.test(text);
  return hasDay && hasPeriod && !hasClock;
}
function clarificationQuestion(input, modelQuestion) {
  const text = String(input || '');
  if (text.includes('明天下午')) return '明天下午几点？';
  if (text.includes('明天晚上')) return '明天晚上几点？';
  if (text.includes('今晚')) return '今晚几点？';
  if (/(周|星期)/.test(text) && /(下午|晚上|上午|早上)/.test(text)) return '这天具体几点？';
  return String(modelQuestion || '').trim() || '具体几点？';
}
function emptyToNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || ['null', 'undefined', 'none', 'n/a'].includes(text.toLowerCase())) return null;
  return text;
}
function hasProvider() { return Boolean(process.env.TODOAI_GEMINI_API_KEY || process.env.TODOAI_QWEN_API_KEY || process.env.TODOAI_DEEPSEEK_API_KEY); }

function rateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) return false;
  recent.push(now); attempts.set(ip, recent); return true;
}

function send(res, value, status) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

export const config = { runtime: 'nodejs' };
