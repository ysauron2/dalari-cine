import test from 'node:test';
import assert from 'node:assert/strict';
import RoomModel from '../src/room-model.js';

const { createRoom, makeMessage, LIMITS, LEGACY_ROLE_MAP } = RoomModel;

// Bytes determinísticos e distintos a cada chamada (apenas para testes).
function seqRandom() {
  let c = 0;
  return (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (c++ * 37 + 11) & 255; return b; };
}
function setup(o = {}) {
  const clock = { t: 1000 };
  const r = createRoom({ now: () => clock.t, randomBytes: seqRandom(), ...o });
  return { clock, room: r.room, code: r.code, hostCredential: r.hostCredential, inviteSecret: r.inviteSecret };
}
const vote = (code, seq) => makeMessage(code, seq, 'vote', { titleId: 'mar-de-inverno', vote: 'yes' });

test('credenciais reais usam crypto da plataforma: >=128 bits, únicas e distintas', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const r = createRoom();
    for (const s of [r.hostCredential, r.inviteSecret]) {
      assert.match(s, /^[A-Za-z0-9_-]{43}$/); // 256 bits em base64url
      assert.ok(!seen.has(s));
      seen.add(s);
    }
    assert.match(r.code, /^\d{6}$/);
  }
});

test('createRoom não usa Math.random', () => {
  const orig = Math.random;
  Math.random = () => { throw new Error('Math.random proibido'); };
  try {
    const r = createRoom();
    r.room.join({ code: r.code, inviteSecret: r.inviteSecret });
  } finally { Math.random = orig; }
});

test('recusa fonte aleatória inválida ou repetida', () => {
  assert.throws(() => createRoom({ randomBytes: (n) => new Uint8Array(n) }), /repetidas|inválida/);
  assert.throws(() => createRoom({ randomBytes: () => new Uint8Array(3) }), /Uint8Array/);
});

test('papéis: criador é host, quem entra é guest, credenciais distintas', () => {
  const s = setup();
  const j = s.room.join({ code: s.code, inviteSecret: s.inviteSecret });
  assert.equal(j.ok, true);
  assert.equal(j.role, 'guest');
  assert.notEqual(j.guestCredential, s.hostCredential);
  assert.notEqual(j.guestCredential, s.inviteSecret);
  assert.equal(s.room.roleOf(s.hostCredential), 'host');
  assert.equal(s.room.roleOf(j.guestCredential), 'guest');
  assert.equal(s.room.roleOf(s.inviteSecret), null);
  assert.equal(s.room.roleOf('x'), null);
  assert.equal(s.room.roleOf('x'.repeat(100000)), null);
  assert.deepEqual(LEGACY_ROLE_MAP, { host: 'you', guest: 'partner' });
});

test('convite: segredo/código errados, uso único e terceiro participante', () => {
  const s = setup();
  assert.equal(s.room.join({ code: s.code, inviteSecret: 'errado' }).reason, 'invalid_invite');
  assert.equal(s.room.join({ code: '000000', inviteSecret: s.inviteSecret }).reason, 'invalid_invite');
  assert.equal(s.room.join({ code: s.code, inviteSecret: s.hostCredential }).reason, 'invalid_invite');
  assert.equal(s.room.join().reason, 'invalid_invite');
  assert.equal(s.room.join(null).reason, 'invalid_invite');
  assert.equal(s.room.join({ code: s.code, inviteSecret: 'x'.repeat(100000) }).reason, 'invalid_invite');
  assert.equal(s.room.join({ code: s.code, inviteSecret: s.inviteSecret }).ok, true);
  assert.equal(s.room.join({ code: s.code, inviteSecret: s.inviteSecret }).reason, 'room_full');
  assert.equal(s.room.describe().guestJoined, true);
});

test('expiração do convite e da sala', () => {
  const a = setup();
  a.clock.t += LIMITS.inviteTtlMs;
  assert.equal(a.room.join({ code: a.code, inviteSecret: a.inviteSecret }).reason, 'invite_expired');
  assert.equal(a.room.describe().guestJoined, false);
  // o host continua usando a sala após o convite expirar
  assert.equal(a.room.receive(a.hostCredential, vote(a.code, 1)).ok, true);
  a.clock.t += LIMITS.roomTtlMs;
  assert.equal(a.room.receive(a.hostCredential, vote(a.code, 2)).reason, 'room_expired');
  assert.equal(a.room.join({ code: a.code, inviteSecret: a.inviteSecret }).reason, 'room_expired');

  const b = setup();
  b.clock.t += LIMITS.inviteTtlMs - 1;
  assert.equal(b.room.join({ code: b.code, inviteSecret: b.inviteSecret }).ok, true);
});

test('mensagem válida devolve o papel da credencial, não do remetente', () => {
  const s = setup();
  const g = s.room.join({ code: s.code, inviteSecret: s.inviteSecret }).guestCredential;
  const h = s.room.receive(s.hostCredential, vote(s.code, 1));
  const w = s.room.receive(g, vote(s.code, 1)); // seq é por papel
  assert.deepEqual([h.ok, h.role, w.ok, w.role], [true, 'host', true, 'guest']);
  assert.deepEqual(w.payload, { titleId: 'mar-de-inverno', vote: 'yes' });
  assert.equal(s.room.receive(null, vote(s.code, 2)).reason, 'unauthenticated');
  assert.equal(s.room.receive(s.inviteSecret, vote(s.code, 2)).reason, 'unauthenticated');
});

test('remetente não pode declarar o próprio papel', () => {
  const s = setup();
  const g = s.room.join({ code: s.code, inviteSecret: s.inviteSecret }).guestCredential;
  for (const k of ['role', 'from', 'sender', 'identity', 'who']) {
    const m = JSON.stringify({ v: 1, room: s.code, type: 'vote', seq: 1, [k]: 'host', payload: { titleId: 'a', vote: 'yes' } });
    assert.equal(s.room.receive(g, m).reason, 'declared_identity', k);
  }
  const inPayload = makeMessage(s.code, 1, 'vote', { titleId: 'a', vote: 'yes', role: 'host' });
  assert.equal(s.room.receive(g, inPayload).reason, 'bad_payload');
});

test('papel errado para o tipo: guest não abre rodada', () => {
  const s = setup();
  const g = s.room.join({ code: s.code, inviteSecret: s.inviteSecret }).guestCredential;
  const m = makeMessage(s.code, 1, 'round', { titleIds: ['a', 'b', 'c'] });
  assert.equal(s.room.receive(g, m).reason, 'wrong_role');
  assert.equal(s.room.receive(s.hostCredential, m).ok, true);
});

test('replay e seq antigo são recusados; falha não consome seq', () => {
  const s = setup();
  assert.equal(s.room.receive(s.hostCredential, vote(s.code, 5)).ok, true);
  assert.equal(s.room.receive(s.hostCredential, vote(s.code, 5)).reason, 'stale_seq');
  assert.equal(s.room.receive(s.hostCredential, vote(s.code, 4)).reason, 'stale_seq');
  assert.equal(s.room.receive(s.hostCredential, makeMessage(s.code, 9, 'vote', { titleId: 'a', vote: 'talvez' })).reason, 'bad_payload');
  assert.equal(s.room.receive(s.hostCredential, vote(s.code, 6)).ok, true);
  for (const seq of [0, -1, 1.5, '7', null, LIMITS.maxSeq + 1]) {
    assert.equal(s.room.receive(s.hostCredential, makeMessage(s.code, seq, 'vote', { titleId: 'a', vote: 'yes' })).reason, 'bad_seq', String(seq));
  }
});

test('mensagens malformadas, desconhecidas, sala errada e versão errada', () => {
  const s = setup();
  const h = s.hostCredential;
  const ok = { v: 1, room: s.code, type: 'vote', seq: 1, payload: { titleId: 'a', vote: 'yes' } };
  const R = (m) => s.room.receive(h, typeof m === 'string' ? m : JSON.stringify(m)).reason;
  assert.equal(R('{nao json'), 'malformed');
  assert.equal(R('[1,2]'), 'malformed');
  assert.equal(R('null'), 'malformed');
  assert.equal(s.room.receive(h, 42).reason, 'malformed');
  assert.equal(R({ ...ok, extra: 1 }), 'malformed');
  assert.equal(R({ v: 1, room: s.code, type: 'vote', seq: 1 }), 'malformed');
  assert.equal(R({ ...ok, type: 'exec' }), 'unknown_type');
  assert.equal(R({ ...ok, type: '__proto__' }), 'unknown_type');
  assert.equal(R({ ...ok, type: 'constructor' }), 'unknown_type');
  assert.equal(R({ ...ok, room: '999999' }), 'wrong_room');
  assert.equal(R({ ...ok, v: 2 }), 'bad_version');
  assert.equal(R('{"__proto__":{"x":1},"v":1}'), 'malformed');
  assert.equal(R({ ...ok, payload: { titleId: '', vote: 'yes' } }), 'bad_payload');
  assert.equal(R({ ...ok, payload: { titleId: 'x'.repeat(65), vote: 'yes' } }), 'bad_payload');
  assert.equal(R({ ...ok, type: 'playback', payload: { action: 'play', positionSec: -1 } }), 'bad_payload');
  assert.equal(R({ ...ok, type: 'history', payload: { titleId: 'a', progress: 101 } }), 'bad_payload');
  assert.equal(R({ ...ok, type: 'round', payload: { titleIds: ['a', 'b', 'c', 'd'] } }), 'bad_payload');
});

test('mensagens grandes são recusadas por bytes UTF-8, em string ou objeto', () => {
  const s = setup();
  const big = { v: 1, room: s.code, type: 'vote', seq: 1, payload: { titleId: 'a', vote: 'yes', pad: 'x'.repeat(LIMITS.maxMessageBytes) } };
  assert.equal(s.room.receive(s.hostCredential, JSON.stringify(big)).reason, 'too_large');
  assert.equal(s.room.receive(s.hostCredential, big).reason, 'too_large');
  // 1000 caracteres de 3 bytes passam de 2048 bytes mesmo com só 1000 chars
  const wide = { ...big, payload: { titleId: 'a', vote: 'yes', pad: '€'.repeat(1000) } };
  assert.equal(s.room.receive(s.hostCredential, JSON.stringify(wide)).reason, 'too_large');
});

test('describe/JSON/erros não vazam credenciais nem segredo de convite', () => {
  const s = setup();
  const joined = s.room.join({ code: s.code, inviteSecret: s.inviteSecret });
  const g = joined.guestCredential;
  const dump = JSON.stringify([s.room, s.room.describe(), s.room.join({ code: s.code, inviteSecret: 'x' }),
    s.room.receive(s.hostCredential, '{ruim'), s.room.receive(g, vote(s.code, 1)), joined]);
  for (const secret of [s.hostCredential, s.inviteSecret, g]) assert.ok(!dump.includes(secret));
  assert.ok(!makeMessage(s.code, 1, 'vote', { titleId: 'a', vote: 'yes' }).includes(s.hostCredential));
  const created = createRoom();
  assert.ok(!JSON.stringify(created).includes(created.hostCredential));
  assert.ok(!JSON.stringify(created).includes(created.inviteSecret));
});
