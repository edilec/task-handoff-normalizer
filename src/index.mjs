export const TOOL_ID = 'task-handoff-normalizer';
export const LIMITS = Object.freeze({ bytes: 1_048_576, tasks: 1000, entries: 20, depth: 16, milliseconds: 5000 });
export const RULE_SEVERITY = Object.freeze({ 'input-unreadable': 'error', 'input-invalid': 'error', 'byte-limit': 'error', 'record-limit': 'error', 'depth-limit': 'error', 'time-limit': 'error', 'source-unknown': 'error', 'owner-missing': 'error', 'objective-missing': 'error', 'context-invalid': 'error', 'acceptance-missing': 'error', 'deadline-invalid': 'error', 'state-unknown': 'error' });
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const forbidden = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\p{Cf}]/u;
const text = x => typeof x === 'string' && x.length <= 500 && x.trim().length > 0 && !forbidden.test(x);
const alias = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);
const list = (x, required, validator) => Array.isArray(x) && x.length >= (required ? 1 : 0) && x.length <= LIMITS.entries && x.every(validator);
function depthExceeded(x, depth = 0) { if (depth > LIMITS.depth) return true; return x && typeof x === 'object' && Object.values(x).some(v => depthExceeded(v, depth + 1)); }
function utcDeadline(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) return null;
  const [, year, month, day, hour, minute, second, offset, , offsetHour, offsetMinute] = m;
  const datePart = `${year}-${month}-${day}`;
  const civil = Date.parse(`${datePart}T00:00:00Z`);
  if (!Number.isFinite(civil) || new Date(civil).toISOString().slice(0, 10) !== datePart || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (offset !== 'Z' && (Number(offsetHour) > 14 || Number(offsetMinute) > 59 || (Number(offsetHour) === 14 && Number(offsetMinute) !== 0))) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}
function add(findings, ruleId, pointer, message) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new Error('Unknown rule');
  findings.push({ ruleId, severity: RULE_SEVERITY[ruleId], message, location: { file: '@input', pointer } });
}
function report(findings, tasks) {
  findings.sort((a, b) => cmp(a.location.file, b.location.file) || cmp(a.location.pointer, b.location.pointer) || cmp(a.ruleId, b.ruleId));
  const status = findings.length ? 'incomplete' : 'pass';
  return { schemaVersion: '1', tool: TOOL_ID, status, summary: { checked: tasks.length, errors: findings.length, warnings: 0 }, findings, tasks };
}
export function incomplete(ruleId, message) { const findings = []; add(findings, ruleId, '', message); return report(findings, []); }

export function normalizeHandoffs(input, { now = () => performance.now() } = {}) {
  const started = now(), findings = [], tasks = [];
  if (!record(input) || input.schemaVersion !== '1' || !Array.isArray(input.tasks) || input.tasks.length === 0) return incomplete('input-invalid', 'A version 1 document with nonempty tasks is required.');
  if (depthExceeded(input)) return incomplete('depth-limit', 'Document exceeds nesting depth 16.');
  if (input.tasks.length > LIMITS.tasks) return incomplete('record-limit', 'Document exceeds 1000 tasks.');
  for (const [i, raw] of input.tasks.entries()) {
    if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', 'Processing exceeded 5000 milliseconds.');
    const at = `/tasks/${i}`;
    if (!record(raw) || !['board-v1', 'queue-v1'].includes(raw.source)) { add(findings, 'source-unknown', `${at}/source`, 'Task export source is unsupported.'); continue; }
    const board = raw.source === 'board-v1';
    const ownerKey = board ? 'assignee' : 'owner';
    const objectiveKey = board ? 'title' : 'objective';
    const refsKey = board ? 'references' : 'contextRefs';
    const acceptanceKey = board ? 'completionCriteria' : 'acceptance';
    const deadlineKey = board ? 'dueAt' : 'deadline';
    const stateKey = board ? 'status' : 'state';
    const before = findings.length;
    if (!alias(raw[ownerKey])) add(findings, 'owner-missing', `${at}/${ownerKey}`, 'Owner alias is absent or unusable.');
    if (!text(raw[objectiveKey])) add(findings, 'objective-missing', `${at}/${objectiveKey}`, 'Objective is absent or unusable.');
    if (!list(raw[refsKey], false, alias)) add(findings, 'context-invalid', `${at}/${refsKey}`, 'Context references must be bounded local aliases.');
    if (!list(raw[acceptanceKey], true, text)) add(findings, 'acceptance-missing', `${at}/${acceptanceKey}`, 'At least one usable acceptance criterion is required.');
    const utc = utcDeadline(raw[deadlineKey]);
    if (utc === null) add(findings, 'deadline-invalid', `${at}/${deadlineKey}`, 'Deadline needs a valid ISO timestamp with explicit UTC offset.');
    const state = board ? { 'To Do': 'todo', 'In Progress': 'in-progress', 'Blocked': 'blocked', 'Done': 'done' }[raw[stateKey]] : raw[stateKey];
    if (!['todo', 'in-progress', 'blocked', 'done'].includes(state)) add(findings, 'state-unknown', `${at}/${stateKey}`, 'Task state is unsupported.');
    if (findings.length !== before) continue;
    tasks.push({ sourceOrdinal: i + 1, owner: raw[ownerKey], objective: raw[objectiveKey], contextRefs: raw[refsKey], acceptance: raw[acceptanceKey], deadline: { original: raw[deadlineKey], utc }, currentState: state });
  }
  return report(findings, tasks);
}
