#!/usr/bin/env node
import { readFile, realpath, stat, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, dirname, basename, isAbsolute, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeHandoffs, incomplete, LIMITS } from '../src/index.mjs';

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--help') {
  process.stdout.write('Usage: task-handoff-normalizer --root DIR --input FILE [--out FILE] [--human]\nJSON report goes to stdout; --out also writes it within root.\n');
} else {
  let root, input, out, human = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--human') { if (human) throw new Error('repeated'); human = true; continue; }
      if (!['--root', '--input', '--out'].includes(a) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('invalid');
      const value = argv[++i];
      if (a === '--root') { if (root) throw new Error('repeated'); root = value; }
      if (a === '--input') { if (input) throw new Error('repeated'); input = value; }
      if (a === '--out') { if (out) throw new Error('repeated'); out = value; }
    }
    if (!root || !input || isAbsolute(input) || (out && isAbsolute(out))) throw new Error('paths');
    root = await realpath(root);
    if (!(await stat(root)).isDirectory()) throw new Error('root');
  } catch { process.stderr.write('Invalid configuration. Use --help.\n'); process.exit(2); }
  const inside = path => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  let result, inputPath;
  try {
    inputPath = await realpath(resolve(root, input));
    if (!inside(inputPath)) throw new Error('input-unreadable');
    const meta = await stat(inputPath);
    if (!meta.isFile()) throw new Error('input-unreadable');
    if (meta.size > LIMITS.bytes) throw new Error('byte-limit');
    const bytes = await readFile(inputPath, { signal: AbortSignal.timeout(LIMITS.milliseconds) });
    if (bytes.length > LIMITS.bytes) throw new Error('byte-limit');
    const doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    result = normalizeHandoffs(doc);
  } catch (e) {
    const rule = e.message === 'byte-limit' ? 'byte-limit' : 'input-unreadable';
    result = incomplete(rule, rule === 'byte-limit' ? 'Input exceeds 1048576 bytes.' : 'Input could not be read, decoded, or parsed within the declared root.');
  }
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (out) {
    try {
      const destination = resolve(root, out);
      if (destination === resolve(root, input)) throw new Error('output aliases named input');
      const parent = await realpath(dirname(destination));
      if (!inside(parent) || !inside(destination)) throw new Error('outside root');
      const namedInput = await realpath(dirname(resolve(root, input))).then(p => join(p, basename(resolve(root, input)))).catch(() => null);
      if (join(parent, basename(destination)) === namedInput) throw new Error('output aliases named input');
      let old;
      try { old = await lstat(destination); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (old?.isSymbolicLink() || old?.isDirectory()) throw new Error('invalid output');
      if (old && inputPath) {
        const source = await stat(inputPath);
        if (old.dev === source.dev && old.ino === source.ino) throw new Error('output aliases input');
      }
      const temp = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
      try { await writeFile(temp, rendered, { flag: 'wx', mode: 0o600 }); await rename(temp, destination); }
      catch (e) { await unlink(temp).catch(() => {}); throw e; }
    } catch { process.stderr.write('Output destination refused or write failed.\n'); process.exit(2); }
  }
  process.stdout.write(rendered);
  if (human) process.stderr.write(`Handoffs: ${result.status}; ${result.summary.checked} tasks normalized; ${result.summary.errors} findings.\n`);
  process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
}
