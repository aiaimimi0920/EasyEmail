import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
const entries = { test: 'runtime', 'test:web': 'web', 'test:release': 'release', 'test:upstream': 'upstream', 'test:portability': 'portability' };
const runner = () => import('../scripts/run-tests.mjs');
const groups = () => JSON.parse(fs.readFileSync(path.join(root, 'scripts/test-groups.json'), 'utf8'));
const inventory = () => fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`).sort();

test('package entries stay short enough for Windows npm without embedding test paths', () => {
  for (const [entry, group] of Object.entries(entries)) {
    assert.ok(scripts[entry].length < 1024, `${entry}: ${scripts[entry].length} characters`);
    assert.equal(scripts[entry], `node scripts/run-tests.mjs ${group}`);
  }
});

test('explicit groups cover every current test without duplicate entries inside a group', async () => {
  const { validateGroups } = await runner(), actual = groups();
  validateGroups(actual, inventory());
  assert.deepEqual([...new Set(Object.values(actual).flat())].sort(), inventory());
  for (const files of Object.values(actual)) assert.equal(new Set(files).size, files.length);
});

test('native Node invocation preserves file order, serial execution and portability VM flags without a shell', async () => {
  const { testInvocation } = await runner();
  for (const group of Object.values(entries)) {
    const invocation = testInvocation(group), files = groups()[group];
    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.options.cwd, root);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.windowsHide, true);
    assert.deepEqual(invocation.args.slice(-files.length), files);
    assert.ok(invocation.args.includes('--test'));
    assert.ok(invocation.args.includes('--test-concurrency=1'));
    assert.equal(invocation.args.includes('--experimental-vm-modules'), group === 'portability');
  }
  assert.ok(testInvocation('runtime').args.join(' ').length > 8191, 'Exercise the original Windows shell limit');
});

test('inventory validation fails closed for omitted, unknown, duplicate and non-canonical test paths', async () => {
  const { validateGroups } = await runner();
  const mutate = change => { const value = groups(); change(value); return value; };
  for (const value of [
    mutate(g => { delete g.web; }),
    mutate(g => { g.unexpected = []; }),
    mutate(g => { g.runtime.push(g.runtime[0]); }),
    mutate(g => { g.runtime.push('../outside.test.mjs'); }),
    mutate(g => { g.runtime.push('tests/absent.test.mjs'); }),
    mutate(g => { g.runtime = g.runtime.filter(file => file !== 'tests/test-runner.test.mjs'); }),
  ]) assert.throws(() => validateGroups(value, inventory()));
});

test('CLI inventory mode does not execute tests; invalid group or extra arguments exit nonzero', async () => {
  const run = args => spawnSync(process.execPath, ['scripts/run-tests.mjs', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, shell: false,
  });
  const listed = run(['runtime', '--list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).files, groups().runtime);
  for (const args of [['unknown'], ['constructor'], ['runtime', '--unexpected'], []]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /TAP version|Subtest:/);
  }
});
