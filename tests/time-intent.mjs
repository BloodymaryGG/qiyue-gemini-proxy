import assert from 'node:assert/strict';
import { recognizeTimeIntent } from '../lib/time-intent.js';

const options = { now: '2026-09-27T01:00:00.000Z', timeZone: 'Asia/Shanghai', language: 'zh-Hans' };

const today = recognizeTimeIntent('今天写雅思小作文，口语跟读', options);
assert.equal(today.status, 'resolved');
assert.equal(today.kind, 'dateOnly');
assert.equal(today.dueDate, '2026-09-27T15:59:59.000Z');
assert.equal(today.reminderDate, null);

const tonight = recognizeTimeIntent('今晚8点提醒我交作业', options);
assert.equal(tonight.dueDate, '2026-09-27T12:00:00.000Z');
assert.equal(tonight.reminderDate, '2026-09-27T12:00:00.000Z');

const relative = recognizeTimeIntent('10分钟后提醒我拿快递', options);
assert.equal(relative.kind, 'relative');
assert.equal(relative.dueDate, '2026-09-27T01:10:00.000Z');
assert.equal(relative.reminderDate, '2026-09-27T01:10:00.000Z');

const vague = recognizeTimeIntent('明天下午写雅思作文', options);
assert.equal(vague.status, 'ambiguous');
assert.equal(vague.question, '明天下午几点？');

const weekday = recognizeTimeIntent('周二下午3点雅思课', options);
assert.equal(weekday.dueDate, '2026-09-29T07:00:00.000Z');

console.log('time-intent regression: PASS');
