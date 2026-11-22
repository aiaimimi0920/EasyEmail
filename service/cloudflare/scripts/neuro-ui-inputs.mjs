import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const installed = fileURLToPath(new URL('../node_modules/@neuro/ui/', import.meta.url));

// file: locks identify a location/version, not the bytes of a mutable local dist.
// Receipt the installed build inputs; release runtime never reads the source repo.
export function neuroUiInputs(directory = installed) {
  const hashes = {};
  function visit(relative) {
    const file = path.join(directory, relative), stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink(), 'Neuro UI build inputs must be installed copies');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`);
    } else {
      assert.ok(stat.isFile(), 'Invalid Neuro UI build input');
      hashes[`dependencies/@neuro/ui/${relative}`] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  assert.ok(!fs.lstatSync(directory).isSymbolicLink(), 'Run ui:sync with install-links=true');
  visit('package.json'); visit('dist');
  for (const file of ['dist/index.js', 'dist/styles.css', 'dist/index.d.ts']) {
    assert.ok(hashes[`dependencies/@neuro/ui/${file}`], `Missing Neuro UI artifact: ${file}`);
  }
  return hashes;
}
