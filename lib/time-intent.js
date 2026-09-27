import { recognizeDateTime } from '@microsoft/recognizers-text-date-time';
import { Culture } from '@microsoft/recognizers-text-date-time';

const DATE_ONLY_WORDS = /(?:今天|今日|明天|后天|大后天|today|tomorrow|the day after tomorrow)/i;
const CLOCK_WORDS = /(?:\d{1,2}\s*(?:点|时)|\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm)\b|\b(?:at|am|pm)\s*\d{1,2})/i;
const RELATIVE_WORDS = /(?:分钟后|小时后|天后|周后|一会儿|稍后|in\s+\d+\s+(?:minute|hour|day)s?)/i;
const REMINDER_WORDS = /(?:提醒我|提醒|叫我|别让我忘|不要忘|remind me|reminder)/i;
const DEADLINE_WORDS = /(?:截止|之前|前完成|交作业|交稿|完成|due|deadline|by\s+)/i;

/**
 * Extracts and normalizes date/time facts before an LLM sees the request.
 * The recognizer returns local calendar values; this module converts them to
 * UTC using the user's IANA timezone and never invents a clock for vague
 * periods such as “明天下午”.
 */
export function recognizeTimeIntent(input, { now = new Date().toISOString(), timeZone = 'Asia/Shanghai', language = 'zh-Hans' } = {}) {
  const text = String(input || '').trim();
  if (!text) return null;
  const referenceDate = new Date(now);
  if (Number.isNaN(referenceDate.getTime())) return null;
  const culture = language.startsWith('zh') ? Culture.Chinese : Culture.English;
  const results = recognizeDateTime(text, culture, undefined, referenceDate, true);
  if (!Array.isArray(results) || results.length === 0) return null;

  const result = results.find((candidate) => candidate?.resolution?.values?.length) || results[0];
  const matchedText = String(result?.text || '').trim();
  const values = result?.resolution?.values || [];
  const hasClock = CLOCK_WORDS.test(matchedText);
  const isRange = String(result?.typeName || '').includes('datetimerange');
  const isRelative = RELATIVE_WORDS.test(matchedText);
  const isDateOnly = !isRelative && (String(result?.typeName || '').endsWith('.date') || (!hasClock && DATE_ONLY_WORDS.test(matchedText)));
  const hasWeekday = /(?:周[一二三四五六日天]|星期[一二三四五六日天]|周末|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)/i.test(matchedText);

  if ((isRange && !hasClock) || (!hasClock && (hasWeekday || /(?:下午|晚上|上午|早上|周末|weekend|later|sometime)/i.test(matchedText)))) {
    return {
      status: 'ambiguous',
      kind: 'vague',
      matchedText,
      question: clarificationQuestion(matchedText, language),
      source: 'microsoft-recognizers',
    };
  }

  const value = chooseValue(values, referenceDate, timeZone);
  if (!value) return null;
  const localParts = parseRecognizerValue(value.value?.value || value.value?.start);
  if (!localParts) return null;
  const resolvedDate = isDateOnly
    ? endOfLocalDay(localParts, timeZone)
    : zonedLocalToUTC(localParts, timeZone);
  if (!resolvedDate) return null;

  const kind = isDateOnly
    ? 'dateOnly'
    : isRelative ? 'relative'
      : REMINDER_WORDS.test(text) ? 'reminder'
        : DEADLINE_WORDS.test(text) ? 'deadline' : 'exactTime';
  return {
    status: 'resolved',
    kind,
    dueDate: resolvedDate.toISOString(),
    reminderDate: REMINDER_WORDS.test(text) && kind !== 'dateOnly' ? resolvedDate.toISOString() : null,
    matchedText,
    source: 'microsoft-recognizers',
  };
}

function chooseValue(values, referenceDate, timeZone) {
  const candidates = values
    .map((value) => ({ value, date: parseRecognizerValue(value.value || value.start) }))
    .filter((candidate) => candidate.date)
    .sort((left, right) => localComparable(left.date) - localComparable(right.date));
  if (!candidates.length) return null;
  const future = candidates.find((candidate) => zonedLocalToUTC(candidate.date, timeZone) >= referenceDate);
  return future || candidates[candidates.length - 1];
}

function localComparable(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function parseRecognizerValue(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  return {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4] || 0), minute: Number(match[5] || 0), second: Number(match[6] || 0),
  };
}

function zonedLocalToUTC(parts, timeZone) {
  const guess = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  const offset = timeZoneOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offset * 60_000);
}

function endOfLocalDay(parts, timeZone) {
  return zonedLocalToUTC({ ...parts, hour: 23, minute: 59, second: 59 }, timeZone);
}

function timeZoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const zone = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = zone.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return match[1] === '-' ? -minutes : minutes;
}

function clarificationQuestion(text, language) {
  if (!language.startsWith('zh')) return 'What time should I use?';
  if (text.includes('明天下午')) return '明天下午几点？';
  if (text.includes('明天晚上')) return '明天晚上几点？';
  if (text.includes('今晚')) return '今晚几点？';
  if (text.includes('周末')) return '周末哪天、几点？';
  return '具体安排在什么时候？';
}
