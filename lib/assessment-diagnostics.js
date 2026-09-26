'use strict';
const crypto = require('crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function questionSet(itemId, questions) {
  const seen = new Map();
  const items = questions.map(text => {
    const stem = hash(`${itemId}\n${String(text).trim()}`).slice(0, 20);
    const occurrence = seen.get(stem) || 0; seen.set(stem, occurrence + 1);
    return { id: `${stem}-${occurrence}`, text: String(text) };
  });
  return { version: 1, setId: hash(JSON.stringify(items)), questions: items };
}
function read(raw, itemId, questions) {
  let value; try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { value = null; }
  const current = questionSet(itemId, questions), answers = {};
  if (!value) return { answers, available: false, current, historical: null };
  if (value.version === 1 && Array.isArray(value.questions)) {
    const stored = new Map(value.questions.map(q => [q.id, q.answer]));
    current.questions.forEach((q, i) => { if (['yes','partial','no'].includes(stored.get(q.id))) answers[i] = stored.get(q.id); });
  } else {
    // Legacy positional responses are retained, never inferred from scores.
    questions.forEach((_, i) => { if (['yes','partial','no'].includes(value[i])) answers[i] = value[i]; });
  }
  return { answers, available: true, current, historical: value };
}
function serialize(itemId, questions, body) {
  const set = questionSet(itemId, questions);
  if (body.diagnostic_set_id && body.diagnostic_set_id !== set.setId) {
    const error = new Error('The diagnostic questions changed. Your draft is safe; reload the questions before recording your conclusion.');
    error.status = 409; throw error;
  }
  return JSON.stringify({ ...set, questions: set.questions.map((q, i) => {
    const answer = body[`q_${i}`] == null ? '' : String(body[`q_${i}`]);
    if (!['','yes','partial','no'].includes(answer)) { const e = new Error('Choose Yes, Partial, No, or leave the diagnostic unanswered.'); e.status = 422; throw e; }
    return { ...q, answer: answer || null };
  }) });
}
module.exports = { questionSet, read, serialize };
