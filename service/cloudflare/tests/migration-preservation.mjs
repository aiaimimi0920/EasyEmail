import assert from "node:assert/strict";

export async function upgradePreservingRows(harness, snapshots) {
  await harness.migrate();
  await harness.migrate();
  for (const [table, before] of snapshots) {
    const name = table.replaceAll('"', '""');
    const current = (await harness.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
    const columns = Object.keys(before[0] ?? {});
    const projected = current.map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
    assert.deepEqual(projected, before, `${table}: full upgrade must preserve original fields and rows`);
  }
}
