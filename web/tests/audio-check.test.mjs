import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const A = require('../server/audio-check.js');

test('volume do microfone: silêncio é 0 e sinal forte chega perto de 1', () => {
  assert.equal(A.rmsOf(new Uint8Array(512).fill(128)), 0);
  assert.equal(A.rmsOf(new Uint8Array(0)), 0);
  const square = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 255 : 1));
  assert.ok(A.rmsOf(square) > 0.98);
  const quiet = Uint8Array.from({ length: 512 }, (_, i) => 128 + (i % 2 ? 3 : -3));
  assert.ok(A.rmsOf(quiet) > 0.02 && A.rmsOf(quiet) < 0.03);
});

test('resultado do microfone: bom, baixo ou mudo, com orientação para cada caso', () => {
  assert.equal(A.classifyMic(0.2).level, 'ok');
  assert.equal(A.classifyMic(0.05).level, 'ok');
  assert.equal(A.classifyMic(0.03).level, 'low');
  assert.match(A.classifyMic(0.03).text, /mais perto/);
  assert.equal(A.classifyMic(0.004).level, 'silent');
  assert.match(A.classifyMic(0).text, /mudo/);
  assert.equal(A.classifyMic(undefined).level, 'silent');
  assert.equal(A.classifyMic('x').level, 'silent');
});

test('lê candidatos ICE e ignora lixo', () => {
  assert.deepEqual(A.parseCandidate('candidate:842163049 1 udp 1677729535 203.0.113.7 51234 typ srflx raddr 192.168.0.10 rport 51234'), { proto: 'udp', ip: '203.0.113.7', port: 51234, type: 'srflx' });
  assert.equal(A.parseCandidate('candidate:1 1 udp 2113937151 192.168.0.10 50000 typ host').type, 'host');
  assert.equal(A.parseCandidate('a=candidate:3 1 tcp 1518280447 10.0.0.5 9 typ host tcptype active').proto, 'tcp');
  assert.equal(A.parseCandidate('candidate:4 1 udp 41885439 198.51.100.2 3478 typ relay').type, 'relay');
  for (const bad of ['', null, undefined, 'lixo', 'candidate:x']) assert.equal(A.parseCandidate(bad), null);
});

const pub = (ip, port) => ({ ip, port, type: 'srflx', proto: 'udp' });

test('rede boa: mesmo endereço e porta nos dois servidores STUN, e o serviço de encontro responde', () => {
  const r = A.classifyNetwork({ srflxA: pub('203.0.113.7', 4000), srflxB: pub('203.0.113.7', 4000), relayOk: true, relayMs: 180 });
  assert.equal(r.level, 'good');
  assert.match(r.title, /boa/);
  assert.ok(r.items.every((i) => i.ok));
});

test('rede difícil: sem UDP/STUN a voz direta provavelmente não conecta', () => {
  const r = A.classifyNetwork({ srflxA: null, srflxB: null, relayOk: true, relayMs: 100 });
  assert.equal(r.level, 'hard');
  assert.match(r.items[0].text, /bloqueado/);
});

test('NAT simétrico (mesmo IP, portas diferentes) e IP diferente por destino pedem atenção e citam o TURN', () => {
  const sym = A.classifyNetwork({ srflxA: pub('203.0.113.7', 4000), srflxB: pub('203.0.113.7', 4999), relayOk: true, relayMs: 100 });
  assert.equal(sym.level, 'warn');
  assert.ok(sym.items.some((i) => !i.ok && /TURN/.test(i.text)));
  const multi = A.classifyNetwork({ srflxA: pub('203.0.113.7', 4000), srflxB: pub('203.0.113.8', 4000), relayOk: true, relayMs: 100 });
  assert.equal(multi.level, 'warn');
});

test('CGNAT/endereço privado, serviço de encontro fora do ar ou lento viram avisos; nunca derrubam para "difícil" sozinhos', () => {
  assert.equal(A.classifyNetwork({ srflxA: pub('100.64.0.9', 1), srflxB: pub('100.64.0.9', 1), relayOk: true, relayMs: 100 }).level, 'good', 'CGNAT 100.64/10 não é detectado como privado pelo aviso simples');
  const priv = A.classifyNetwork({ srflxA: pub('10.1.2.3', 1), srflxB: pub('10.1.2.3', 1), relayOk: true, relayMs: 100 });
  assert.equal(priv.level, 'warn');
  const down = A.classifyNetwork({ srflxA: pub('203.0.113.7', 4000), srflxB: pub('203.0.113.7', 4000), relayOk: false });
  assert.equal(down.level, 'warn');
  assert.ok(down.items.some((i) => /ntfy\.sh/.test(i.text) && /convite longo/.test(i.text)));
  const slow = A.classifyNetwork({ srflxA: pub('203.0.113.7', 4000), srflxB: pub('203.0.113.7', 4000), relayOk: true, relayMs: 2400 });
  assert.equal(slow.level, 'warn');
  assert.match(slow.items.at(-1).text, /devagar/);
  const worstWins = A.classifyNetwork({ srflxA: null, relayOk: false });
  assert.equal(worstWins.level, 'hard');
});

test('marca de "já fez o assistente" e acesso bloqueado ao armazenamento', () => {
  const store = new Map();
  const win = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  assert.equal(A.hasSeen(win), false);
  A.markSeen(win);
  assert.equal(A.hasSeen(win), true);
  assert.equal(A.hasSeen({ get localStorage() { throw new Error('bloqueado'); } }), false);
  A.markSeen({ get localStorage() { throw new Error('bloqueado'); } });
  assert.equal(A.PREF_KEY, 'duotela-audio-devices', 'usa a mesma chave de preferências da chamada de voz');
});

test('a página carrega o assistente, o botão existe em Perfil e o serviço o entrega; o aviso de fone está no texto', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="server\/audio-check\.js"><\/script>/);
  assert.match(html, /data-duo-open="audiocheck"/);
  assert.match(readFileSync(new URL('../server/room-service.js', import.meta.url), 'utf8'), /'\/server\/audio-check\.js', 'server\/audio-check\.js'/);
  const src = readFileSync(new URL('../server/audio-check.js', import.meta.url), 'utf8');
  assert.match(src, /Use fones de ouvido/);
  assert.match(src, /Testar minha conexão/);
});
