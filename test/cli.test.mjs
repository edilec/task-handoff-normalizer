import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../bin/task-handoff-normalizer.mjs', import.meta.url).pathname;
const good = { schemaVersion: '1', tasks: [{ source: 'queue-v1', owner: 'team-a', objective: 'Ship sample', contextRefs: ['doc-1'], acceptance: ['Check output'], deadline: '2026-01-05T10:30:00+05:30', state: 'todo' }] };
async function run(doc = good, extra = []) {
  const root = await mkdtemp(join(tmpdir(), 'handoff-test-'));
  await writeFile(join(root, 'input.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
  const p = spawnSync(process.execPath, [cli, '--root', root, '--input', 'input.json', ...extra], { encoding: 'utf8', maxBuffer: 4_194_304 });
  await rm(root, { recursive: true, force: true });
  return { code: p.status, stdout: p.stdout, stderr: p.stderr, report: p.stdout ? JSON.parse(p.stdout) : null };
}
test('good export passes and carries both deadline values', async () => {
  const r = await run(); assert.equal(r.code, 0); assert.equal(r.report.status, 'pass');
  assert.deepEqual(r.report.tasks[0].deadline, { original: '2026-01-05T10:30:00+05:30', utc: '2026-01-05T05:00:00Z' });
});
test('missing owner is incomplete with source pointer', async () => {
  const d = structuredClone(good); d.tasks[0].owner = '';
  const r = await run(d); assert.equal(r.code, 2); assert.equal(r.report.status, 'incomplete');
  assert.equal(r.report.findings[0].location.pointer, '/tasks/0/owner'); assert.equal(r.stdout.includes('Ship sample'), false);
});
test('unknown CLI option is configuration error with empty stdout', async () => {
  const r = await run(good, ['--unexpected']);
  assert.equal(r.code, 2); assert.equal(r.stdout, '');
});
test('malformed JSON with quoted text does not leak', async () => {
  const r = await run('at position 1'); assert.equal(r.code, 2); assert.equal(r.report.findings[0].ruleId, 'input-unreadable');
  assert.equal(r.stdout.includes('at position 1'), false);
});
test('strict UTF-8 input is required', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-utf8-'));
  await writeFile(join(root, 'input.json'), Buffer.from([0xff]));
  const p = spawnSync(process.execPath, [cli, '--root', root, '--input', 'input.json'], { encoding: 'utf8' });
  assert.equal(p.status, 2); assert.equal(JSON.parse(p.stdout).findings[0].ruleId, 'input-unreadable');
  await rm(root, { recursive: true, force: true });
});
test('symlink input cannot leave declared root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-root-')), outside = await mkdtemp(join(tmpdir(), 'handoff-out-'));
  await writeFile(join(outside, 'secret.json'), 'secret-value'); await symlink(join(outside, 'secret.json'), join(root, 'input.json'));
  const p = spawnSync(process.execPath, [cli, '--root', root, '--input', 'input.json'], { encoding: 'utf8' });
  assert.equal(p.status, 2); assert.equal(JSON.parse(p.stdout).status, 'incomplete'); assert.equal(p.stdout.includes('secret-value'), false);
  await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
});
test('ordinary output copies stdout and hard-link alias is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-output-'));
  const original = JSON.stringify(good);
  try {
    await writeFile(join(root, 'input.json'), original);
    const args = [cli, '--root', root, '--input', 'input.json', '--out'];
    const allowed = spawnSync(process.execPath, [...args, 'report.json'], { encoding: 'utf8' });
    assert.equal(allowed.status, 0); assert.equal(await readFile(join(root, 'report.json'), 'utf8'), allowed.stdout);
    await link(join(root, 'input.json'), join(root, 'alias.json'));
    const denied = spawnSync(process.execPath, [...args, 'alias.json'], { encoding: 'utf8' });
    assert.equal(denied.status, 2); assert.equal(denied.stdout, ''); assert.equal(await readFile(join(root, 'input.json'), 'utf8'), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('byte bound accepts 1048576 and rejects 1048577', async () => {
  const base = JSON.stringify(good), exact = base + ' '.repeat(1_048_576 - Buffer.byteLength(base));
  const at = await run(exact), over = await run(exact + ' ');
  assert.equal(at.code, 0); assert.equal(over.code, 2); assert.equal(over.report.findings[0].ruleId, 'byte-limit');
});
test('depth bound accepts 16 and rejects 17', async () => {
  const nested = n => { const d = structuredClone(good); let node = d; for (let i = 0; i < n; i++) { node.extra = {}; node = node.extra; } return d; };
  const at = await run(nested(16)), over = await run(nested(17));
  assert.equal(at.code, 0); assert.equal(over.code, 2); assert.equal(over.report.findings[0].ruleId, 'depth-limit');
});
test('task record bound accepts 1000 and rejects 1001', async () => {
  const d = { schemaVersion: '1', tasks: Array.from({ length: 1000 }, () => ({ ...good.tasks[0] })) };
  const at = await run(d); assert.equal(at.code, 0); assert.equal(at.report.summary.checked, 1000);
  d.tasks.push({ ...good.tasks[0] });
  const over = await run(d); assert.equal(over.code, 2); assert.equal(over.report.findings[0].ruleId, 'record-limit');
});
test('report output refuses symlink destination and parent escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-symlink-root-')), outside = await mkdtemp(join(tmpdir(), 'handoff-symlink-out-'));
  try {
    await writeFile(join(root, 'input.json'), JSON.stringify(good)); await writeFile(join(outside, 'sentinel.json'), 'sentinel');
    await symlink(join(outside, 'sentinel.json'), join(root, 'report.json'));
    const args = [cli, '--root', root, '--input', 'input.json', '--out'];
    const direct = spawnSync(process.execPath, [...args, 'report.json'], { encoding: 'utf8' });
    assert.equal(direct.status, 2); assert.equal(direct.stdout, '');
    await symlink(outside, join(root, 'linked'));
    const parent = spawnSync(process.execPath, [...args, 'linked/sentinel.json'], { encoding: 'utf8' });
    assert.equal(parent.status, 2); assert.equal(parent.stdout, '');
    assert.equal(await readFile(join(outside, 'sentinel.json'), 'utf8'), 'sentinel');
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('report output cannot create missing input through in-root alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-missing-'));
  try {
    await symlink(root, join(root, 'alias'));
    const p = spawnSync(process.execPath, [cli, '--root', root, '--input', 'missing.json', '--out', 'alias/missing.json'], { encoding: 'utf8' });
    assert.equal(p.status, 2); assert.equal(p.stdout, '');
    await assert.rejects(readFile(join(root, 'missing.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
