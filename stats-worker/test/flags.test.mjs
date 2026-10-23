import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.js';

const T0 = 1_800_000_000;
const get = (env, method = 'GET') => handle(new Request('https://stats.example/v1/flags', { method }), env, T0);

test('GET /v1/flags: Netflix ligada por padrão; NETFLIX_OFF=1 desliga, com aviso limpo e sem cache', async () => {
  let r = await get({});
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, netflix: true });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  for (const v of ['0', '', 'sim', undefined]) assert.equal((await (await get({ NETFLIX_OFF: v })).json()).netflix, true, String(v));
  r = await get({ NETFLIX_OFF: '1', NETFLIX_OFF_MESSAGE: 'Netflix em manutenção <script>x</script> ' + 'a'.repeat(400) });
  const body = await r.json();
  assert.equal(body.netflix, false);
  assert.ok(body.message.startsWith('Netflix em manutenção') && !/[<>]/.test(body.message) && body.message.length <= 200);
  assert.deepEqual(await (await get({ NETFLIX_OFF: ' 1 ' })).json(), { ok: true, netflix: false });
});

test('GET /v1/flags: só GET e OPTIONS, e não depende do banco', async () => {
  assert.equal((await get({}, 'POST')).status, 405);
  assert.equal((await get({}, 'OPTIONS')).status, 204);
});
