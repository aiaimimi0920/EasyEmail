import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const groupNames = ['runtime', 'web', 'release', 'upstream', 'portability'];

export function validateGroups(groups, inventory) {
  assert.ok(groups && typeof groups === 'object' && !Array.isArray(groups), 'Test groups must be an object');
  assert.deepEqual(Object.keys(groups).sort(), [...groupNames].sort(), 'Unexpected test groups');
  const available = new Set(inventory), covered = new Set();
  for (const [group, files] of Object.entries(groups)) {
    assert.ok(Array.isArray(files) && files.length, `Empty or invalid test group: ${group}`);
    assert.equal(new Set(files).size, files.length, `Duplicate files in test group: ${group}`);
    for (const file of files) {
      assert.ok(typeof file === 'string' && /^tests\/[a-z0-9-]+\.test\.mjs$/.test(file), 'Test paths must be canonical');
      assert.ok(available.has(file), `Missing test file: ${file}`);
      covered.add(file);
    }
  }
  assert.deepEqual([...covered].sort(), [...available].sort(), 'Test inventory has unassigned files');
}

function loadGroups() {
  const groups = JSON.parse(fs.readFileSync(path.join(root, 'scripts/test-groups.json'), 'utf8'));
  const inventory = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`);
  validateGroups(groups, inventory);
  return groups;
}

export function testInvocation(group) {
  assert.ok(groupNames.includes(group), 'Unknown test group');
  const groups = loadGroups();
  return {
    command: process.execPath,
    args: [...(group === 'portability' ? ['--experimental-vm-modules'] : []), '--test', '--test-concurrency=1', ...groups[group]],
    options: { cwd: root, stdio: 'inherit', windowsHide: true, shell: false },
  };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const [group, option, ...extra] = process.argv.slice(2);
    assert.ok(!extra.length && (option === undefined || option === '--list'), 'Usage: node scripts/run-tests.mjs <group> [--list]');
    const invocation = testInvocation(group);
    if (option === '--list') console.log(JSON.stringify({ group, files: loadGroups()[group] }));
    else {
      const result = spawnSync(invocation.command, invocation.args, invocation.options);
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
