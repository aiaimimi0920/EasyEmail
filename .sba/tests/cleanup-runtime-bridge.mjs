// Cloud metadata/deletion stays synthetic; object listing and deletion use the target's actual native R2.
import assert from 'node:assert/strict';
import http from 'node:http';

export async function cleanupRuntimeBridge(target, config) {
  const commands = [], errors = [];
  const bindings = new Map(['inboxBucket', 'outboxBucket'].map((field, index) => [config.platform[field], ['INBOX', 'OUTBOX'][index]]));
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(bindings.has(input.bucket)); assert.ok(['list', 'delete'].includes(input.command));
      const bucket = await target.bucket(bindings.get(input.bucket)); let result;
      if (input.command === 'list') {
        const listing = await bucket.list(); assert.equal(listing.truncated, false);
        result = listing.objects.map(row => ({key: row.key, size: row.size, etag: row.etag, last_modified: row.uploaded.toISOString()}));
      } else {
        assert.ok(Array.isArray(input.keys) && input.keys.length > 0 && input.keys.length <= 1000);
        await bucket.delete(input.keys); result = input.keys.map(key => ({key}));
        commands.push({bucket: input.bucket, keys: input.keys});
        for (const key of input.keys) assert.equal(await bucket.get(key), null);
      }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { errors.push(error.message); response.statusCode = 500; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {port: server.address().port, commands, errors, close: () => new Promise(resolve => server.close(resolve))};
}
