import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');

test('a origem do serviço de estatísticas entra no connect-src da CSP; origem inválida é recusada; stats-config.json é servido', async () => {
  for (const bad of ['http://evil.example.com', 'javascript:alert(1)', 'https://x.com/path', 'https://u:p@x.com']) assert.throws(() => createRoomService({ statsOrigin: bad }), TypeError, bad);
  const off = createRoomService({ servePrototype: true }); const a = await off.listen(0, '127.0.0.1');
  const on = createRoomService({ servePrototype: true, statsOrigin: 'https://dalari-stats.exemplo.workers.dev' }); const b = await on.listen(0, '127.0.0.1');
  try {
    const csp = async (port) => (await fetch(`http://127.0.0.1:${port}/`)).headers.get('content-security-policy');
    assert.doesNotMatch(await csp(a.port), /workers\.dev/);
    assert.match(await csp(b.port), /connect-src 'self' https:\/\/ntfy\.sh https:\/\/dalari-stats\.exemplo\.workers\.dev;/);
    const cfg = await fetch(`http://127.0.0.1:${b.port}/stats-config.json`);
    assert.equal(cfg.status, 200);
    const body = await cfg.json();
    assert.equal(typeof body.url, 'string'); assert.equal(typeof body.version, 'string');
  } finally { await off.close(); await on.close(); }
});
