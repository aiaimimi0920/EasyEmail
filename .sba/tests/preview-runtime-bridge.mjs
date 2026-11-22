// Test-only CLI/import boundary. Data, authentication and object transfer still run in real Workers/D1/R2.
import assert from 'node:assert/strict';
import http from 'node:http';
import { migrationStatements } from '../../service/cloudflare/tests/migration-sql.mjs';
import { upgradeRuntimeBridge } from './upgrade-runtime-bridge.mjs';

export async function previewRuntimeBridge(source, target, configurations, { publish, importedEmail = false } = {}) {
  const sourceBridge = await upgradeRuntimeBridge(source, configurations.source);
  const targetBridge = await upgradeRuntimeBridge(target, configurations.target);
  const commands = [], errors = [], restored = new Set(importedEmail ? ['email'] : []);
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(['restore-email', 'restore-platform', 'migrate', ...(publish ? ['publish-email','publish-platform'] : [])].includes(input.command));
      assert.ok(!commands.includes(input.command)); commands.push(input.command);
      if (input.command.startsWith('publish-')) {
        await publish(input.command.slice(8));
      } else if (input.command.startsWith('restore-')) {
        const role = input.command.slice(8), database = role === 'email' ? target.emailDb : target.db;
        assert.equal((await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*'").all()).results.length, 0);
        const statements = migrationStatements(input.sql).filter(sql => !/^\s*(?:BEGIN TRANSACTION|COMMIT)\s*;?\s*$/i.test(sql));
        // Remote /import is not a single /query transaction; exercise every statement with FK enforcement.
        for (const sql of statements) await database.prepare(sql).run();
        restored.add(role);
      } else {
        assert.deepEqual([...restored].sort(), ['email', 'platform']);
        assert.deepEqual(await target.reapplyMigrations(), []); await target.restart();
      }
      response.setHeader('content-type', 'application/json'); response.end('{}');
    } catch (error) { errors.push(error.message); response.statusCode = 500; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { source: sourceBridge, target: targetBridge, port: server.address().port, commands, errors,
    async close() { await new Promise(resolve => server.close(resolve)); await targetBridge.close(); await sourceBridge.close(); } };
}
