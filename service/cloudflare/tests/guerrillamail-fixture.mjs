import assert from "node:assert/strict";
import { createServer } from "node:http";

// Independent public-session peer, with rotating tokens and no real provider calls.
export async function guerrillamailFixture() {
  const calls = [], sessions = new Map(), messages = new Map(), modes = new Map(), replies = new Map(), rotations = new Set(), gates = new Map();
  let sequence = 0;
  const session = (address) => {
    const row = { address, token: `synthetic-guerrilla-${++sequence}` }; sessions.set(row.token, row); return row;
  };
  const rotate = (row) => { sessions.delete(row.token); row.token = `synthetic-guerrilla-${++sequence}`; sessions.set(row.token, row); };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"), f = url.searchParams.get("f"), query = url.searchParams;
    calls.push({ f, query, method: request.method, headers: request.headers });
    const send = (data, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    try {
      assert.equal(url.pathname, "/ajax.php"); assert.equal(request.method, "GET"); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
      const gate = gates.get(f);
      if (gate) { gates.delete(f); gate.enter(); await gate.wait; }
      const mode = modes.get(f);
      if (mode === "redirect") { response.writeHead(302, { location: "https://invalid.example/exfiltrate" }); response.end(); return; }
      if (mode === "invalid") { response.writeHead(200, { "content-type": "application/json" }); response.end("not JSON"); return; }
      if (mode === "html") { response.writeHead(200, { "content-type": "text/html" }); response.end("synthetic-private-error"); return; }
      if (mode === "oversized") { send({ content: "x".repeat(2 * 1024 * 1024) }); return; }
      if (typeof mode === "number") { send({ error: "synthetic-private-error" }, mode); return; }
      if (replies.has(f)) { send(replies.get(f)); return; }
      if (f === "get_email_address") {
        assert.equal(query.has("sid_token"), false); const row = session(`seed${sequence + 1}@guerrilla.example.test`);
        if (mode === "lost-ack") { response.destroy(); return; }
        send({ email_addr: row.address, sid_token: row.token, email_timestamp: Math.floor(Date.now() / 1000) }); return;
      }
      const row = sessions.get(query.get("sid_token"));
      if (!row) { const replacement = session("replacement@guerrilla.example.test"); send({ email: replacement.address, sid_token: replacement.token, list: [], count: "0" }); return; }
      if (f === "set_email_user") {
        assert.match(query.get("email_user"), /^ee[a-f0-9]{32}$/); row.address = `${query.get("email_user")}@guerrilla.example.test`; rotate(row);
        if (mode === "lost-ack") { response.destroy(); return; }
        send({ email_addr: row.address, sid_token: row.token }); return;
      }
      if (rotations.delete(f)) rotate(row);
      const rows = [...(messages.get(row.address) ?? [])].sort((a, b) => Number(b.mail_id) - Number(a.mail_id));
      if (f === "check_email" || f === "get_older_list") {
        if (f === "check_email") assert.equal(query.get("seq"), "0");
        else assert.equal(query.get("limit"), "20");
        const selected = f === "check_email" ? rows : rows.filter(mail => BigInt(mail.mail_id) < BigInt(query.get("seq")));
        send({ email: row.address, sid_token: row.token, count: String(rows.length), list: selected.slice(0, 20).map(({ mail_body, mail_recipient, content_type, ...mail }) => mail) }); return;
      }
      assert.equal(f, "fetch_email"); const mail = rows.find(mail => mail.mail_id === query.get("email_id"));
      if (mail) mail.mail_read = "1";
      send(mail ? { ...mail, sid_token: row.token } : false);
    } catch (error) { send({ fixtureError: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { id: "guerrillamail", type: "guerrillamail", baseUrl: `http://127.0.0.1:${server.address().port}/ajax.php`, domains: ["guerrilla.example.test"], enabled: true,
    authentication: "anonymous", sendRecipients: [] };
  return { calls, sessions, messages, modes, replies, rotations, config,
    bindings: { PROVIDER_CONFIG: JSON.stringify([config]), PROVIDER_SECRETS: "not used in public mode", MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "a3".repeat(32) } }) },
    hold(f) {
      let enter, release;
      const entered = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Fixture gate not reached: ${f}`)), 10000); timer.unref();
        enter = () => { clearTimeout(timer); resolve(); }; });
      const wait = new Promise(resolve => { release = resolve; }); gates.set(f, { enter, wait }); return { entered, release };
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export function guerrillaMail(address, n = 1) {
  return { mail_id: String(n), mail_from: "noreply@example.test", mail_recipient: address, mail_subject: `Guerrilla &amp; &#x1F600; ${n}`,
    mail_excerpt: "Your verification code is 946281.", mail_body: '<b>946281</b><img src="https://invalid.example/pixel"><script>window.guerrillaExecuted=true</script>',
    content_type: "text/html", mail_timestamp: String(Math.floor(Date.now() / 1000)), mail_read: "0", att: "0" };
}
