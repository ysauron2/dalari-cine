import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient } = require('../server/client.js');
const { VoiceCall } = require('../server/voice.js');
const MatchEngine = require('../src/match-engine.js');

async function boot(opts = {}) {
  const clock = { t: 1_000_000 };
  const svc = createRoomService({ now: () => clock.t, logger: () => {}, ...opts });
  const addr = await svc.listen(0, '127.0.0.1');
  return { url: `http://127.0.0.1:${addr.port}`, clock, svc, stop: () => svc.close() };
}
const mk = (env) => new DuoRoomClient({ serviceUrl: env.url });
const sync = (...cs) => Promise.all(cs.map((c) => c.getState({ after: 0 })));
const jsonPost = (env, path, token, body) => fetch(env.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

/** Host + (n-1) convidados admitidos, um convite de uso único por pessoa, aprovação só na entrada. */
async function fill(env, n = 4, { names = ['Ana', 'Beto', 'Cida', 'Davi'] } = {}) {
  const host = mk(env);
  const created = await host.createRoom(names[0], { maxParticipants: 4 });
  const clients = [host];
  let invite = created.invite;
  for (let i = 1; i < n; i++) {
    const g = mk(env);
    await g.joinRoom(invite, names[i]);
    await host.approveGuest(g.role);
    clients.push(g);
    if (i < n - 1) invite = (await host.newInvite()).invite;
  }
  await sync(...clients);
  return { host, clients, guests: clients.slice(1), created };
}

test('4 pessoas: Host + 3 convidados com identidades próprias, convite de uso único e quinto recusado', async () => {
  const env = await boot();
  try {
    const { host, clients, created } = await fill(env, 4);
    assert.deepEqual(clients.map((c) => c.role), ['host', 'guest', 'guest2', 'guest3']);
    const tokens = clients.map((c) => c.exportSession().token);
    assert.equal(new Set(tokens).size, 4);
    const s = await host.getState({ after: 0 });
    assert.equal(s.status, 'active');
    assert.equal(s.capacity, 4);
    assert.deepEqual(s.participants.map((p) => [p.id, p.name]), [['host', 'Ana'], ['guest', 'Beto'], ['guest2', 'Cida'], ['guest3', 'Davi']]);
    assert.equal(s.names.guest3, 'Davi');
    // sala lotada: não há como gerar convite, e o convite antigo já foi usado
    await assert.rejects(host.newInvite(), (e) => e.code === 'room_full');
    await assert.rejects(mk(env).joinRoom(created.invite, 'Eva'), (e) => ['invite_used', 'invalid_invite'].includes(e.code));   // usado ou substituído por convite novo
    // quinto com um convite emitido enquanto havia vaga: recusado depois de lotar
    const lateHost = mk(env);
    const c2 = await lateHost.createRoom('Lia', { maxParticipants: 3 });
    const a = mk(env), b = mk(env);
    await a.joinRoom(c2.invite, 'Ana2'); await lateHost.approveGuest();
    const inv2 = await lateHost.newInvite();
    await b.joinRoom(inv2.invite, 'Bia'); await lateHost.approveGuest();
    await assert.rejects(lateHost.newInvite(), (e) => e.code === 'room_full');
    // pendentes contam como vaga ocupada: com 3 vagas e 1 pendente, o terceiro convite não cabe
    const h3 = mk(env);
    const c3 = await h3.createRoom('Host3', { maxParticipants: 3 });
    const p1 = mk(env); await p1.joinRoom(c3.invite, 'P1');
    const inv3 = await h3.newInvite();
    const p2 = mk(env); await p2.joinRoom(inv3.invite, 'P2');
    await assert.rejects(h3.newInvite(), (e) => e.code === 'room_full');
    // nenhum snapshot expõe credenciais de ninguém
    const blob = JSON.stringify(await sync(...clients));
    for (const t of tokens) assert.ok(!blob.includes(t));
  } finally { await env.stop(); }
});

test('entrada exige aprovação do Host uma única vez; depois nenhuma ação pede aprovação', async () => {
  const env = await boot();
  try {
    const host = mk(env);
    const created = await host.createRoom('Ana', { maxParticipants: 4 });
    const g1 = mk(env), g2 = mk(env);
    await g1.joinRoom(created.invite, 'Beto');
    const inv = await host.newInvite();              // convite novo com um pedido pendente
    await g2.joinRoom(inv.invite, 'Cida');
    let hs = await host.getState({ after: 0 });
    assert.deepEqual(hs.pendingGuests.map((p) => p.id), ['guest', 'guest2']);
    // sem id, com dois pendentes, a decisão é ambígua
    await assert.rejects(host.approveGuest(), (e) => e.code === 'participant_required');
    // pendente não age nem vê a sala
    await assert.rejects(g1.setViewing('noite', { progress: 5 }), (e) => e.code === 'not_active');
    assert.equal((await g1.getState({ after: 0 })).round, undefined);
    // convidado não aprova ninguém, nem a si mesmo
    await assert.rejects(g1.approveGuest('guest'), (e) => e.code === 'wrong_role');
    await host.approveGuest('guest');
    await host.denyGuest('guest2');
    assert.equal((await g2.getState({ after: 0 })).status, 'guest_denied');
    await sync(host, g1);
    // ações de plataforma, mídia, voto, reprodução e voz acontecem sem nova aprovação
    await host.selectPlatform('youtube');
    await host.startRound('surprise');
    const [a] = host.snapshot.round.picks;
    await g1.getState({ after: 0 });
    await g1.vote(a, 'yes'); await host.vote(a, 'yes');
    await g1.selectYouTubeVideo(a, 'abcdefghijk');
    await host.getState({ after: 0 });
    await host.playback(a, 'pause', 9);
    await host.voiceReady(true); await g1.voiceReady(true);
    assert.equal((await g1.getState({ after: 0 })).playback.state, 'paused');
  } finally { await env.stop(); }
});

test('votos individuais: 3/4 não é match, 4/4 é; ninguém vota por outra pessoa', async () => {
  const env = await boot();
  try {
    const { host, clients, guests } = await fill(env, 4);
    await host.selectPlatform('netflix');
    await host.startRound('surprise');
    const [a, b] = host.snapshot.round.picks;
    assert.deepEqual(host.snapshot.round.participants, ['host', 'guest', 'guest2', 'guest3']);
    await sync(...clients);
    await host.vote(a, 'yes'); await guests[0].vote(a, 'yes'); await guests[1].vote(a, 'yes');
    let s = await guests[2].getState({ after: 0 });
    assert.equal(s.selectedMatch, null);
    assert.equal(s.round.result.status, 'voting');
    assert.deepEqual(s.round.votes.host, { [a]: 'yes' });
    assert.equal(s.round.votes.guest3[a], undefined);          // quem não votou aparece pendente
    // identidade não vem do corpo: papel/participante declarados são recusados, mesmo com token válido
    const t = guests[2].exportSession().token;
    for (const extra of [{ participant: 'host' }, { role: 'host' }, { from: 'guest' }]) {
      const r = await jsonPost(env, `/v1/rooms/${host.code}/actions`, t, { v: 1, clientSeq: 99, type: 'vote', payload: { round: s.round.roundNumber, titleId: a, vote: 'yes' }, ...extra });
      assert.equal(r.json.error, 'declared_identity');
    }
    const r2 = await jsonPost(env, `/v1/rooms/${host.code}/actions`, t, { v: 1, clientSeq: 99, type: 'vote', payload: { round: s.round.roundNumber, titleId: a, vote: 'yes', who: 'guest' } });
    assert.equal(r2.json.error, 'bad_payload');
    // o quarto "não" derruba o título A; o quarto "sim" no B não basta sem os demais
    await guests[2].vote(a, 'no');
    s = await host.getState({ after: 0 });
    assert.equal(s.selectedMatch, null);
    assert.equal(s.round.votes.guest3[a], 'no');
    await guests[2].vote(b, 'yes'); await host.vote(b, 'yes'); await guests[0].vote(b, 'yes');
    assert.equal((await host.getState({ after: 0 })).selectedMatch, null);   // faltam 4/4 no B
    await guests[1].vote(b, 'yes');
    s = await host.getState({ after: 0 });
    assert.equal(s.selectedMatch, b);
    await assert.rejects(guests[0].vote(a, 'yes'), (e) => e.code === 'round_locked');
    // todos os aprovados controlam a mídia selecionada
    await guests[2].selectNetflixTitle(b, '80057281');
    for (const [i, c] of clients.entries()) {
      await c.getState({ after: 0 });
      await c.playbackNetflix(b, '80057281', i % 2 ? 'pause' : 'play', 10 + i);
    }
    const final = await host.getState({ after: 0 });
    assert.equal(final.playback.updatedBy, 'guest3');
    assert.equal(final.playback.version, 5);
  } finally { await env.stop(); }
});

test('motor de match: dupla inalterada, unanimidade para 3 e 4, pessoas fora da lista não votam', () => {
  const catalog = [{ id: 'x', title: 'X', genre: 'Drama', kind: 'Filme', tags: [], warmth: 1, adventure: 1 }, { id: 'y', title: 'Y', genre: 'Comédia', kind: 'Série', tags: [], warmth: 1, adventure: 1 }];
  const pair = MatchEngine.createRound(null, catalog, {}, { mode: 'surprise' });
  assert.equal(pair.people, undefined);
  assert.deepEqual(Object.keys(pair.votes), ['you', 'partner']);
  const four = MatchEngine.createRound(null, catalog, {}, { mode: 'surprise', people: ['you', 'partner', 'p3', 'p4'] });
  let r = four;
  for (const p of ['you', 'partner', 'p3']) r = MatchEngine.castVote(r, p, 'x', 'yes');
  assert.equal(MatchEngine.resolveRound(r).status, 'voting');
  r = MatchEngine.castVote(r, 'p4', 'x', 'yes');
  assert.deepEqual(MatchEngine.resolveRound(r), { status: 'match', matchId: 'x' });
  const three = MatchEngine.createRound(null, catalog, {}, { mode: 'surprise', people: ['you', 'partner', 'p3'] });
  assert.equal(MatchEngine.castVote(three, 'p4', 'x', 'yes'), three);          // p4 não está na rodada
  assert.equal(MatchEngine.sanitizeRound({ ...four, people: ['you', 'p4'] }, catalog).people.join(), 'you,p4');
  assert.equal(MatchEngine.sanitizeRound({ ...four, people: ['you', 'ninguem'] }, catalog), null);
});

test('mudança de composição reinicia a rodada com aviso: entrada, saída e remoção', async () => {
  const env = await boot();
  try {
    const { host, clients, guests } = await fill(env, 3);
    await host.selectPlatform('youtube');
    await host.startRound('surprise');
    const [a] = host.snapshot.round.picks;
    await sync(...clients);
    await host.vote(a, 'yes'); await guests[0].vote(a, 'yes');
    const before = (await host.getState({ after: 0 })).round.roundNumber;
    // entrada tardia: votos antigos não valem; a rodada pede novo voto de 4 pessoas
    const inv = await host.newInvite();
    const d = mk(env); await d.joinRoom(inv.invite, 'Davi');
    assert.equal((await host.getState({ after: 0 })).round.roundNumber, before);   // pendente ainda não altera nada
    await host.approveGuest('guest3');
    let s = await host.getState({ after: 0 });
    assert.equal(s.round.roundNumber, before + 1);
    assert.deepEqual(s.round.participants, ['host', 'guest', 'guest2', 'guest3']);
    assert.deepEqual(s.round.votes.host, {});
    assert.equal(s.notice.kind, 'round_restarted');
    assert.equal(s.notice.reason, 'joined');
    assert.equal(s.notice.name, 'Davi');
    assert.match(s.round.summary, /Davi entrou/);
    assert.deepEqual(s.round.picks.length, 3);
    await assert.rejects(guests[0].vote(a, 'yes'), (e) => e.code === 'stale_round');   // voto da rodada antiga
    // remoção reinicia de novo e remove a pessoa da contagem
    await sync(...clients, d);
    for (const c of [host, ...guests, d]) await c.vote(a, 'yes').catch(() => {});
    assert.equal((await host.getState({ after: 0 })).selectedMatch, a);
    // rodada com match: remover alguém não destrói o título nem a mídia
    await host.selectYouTubeVideo(a, 'abcdefghijk');
    await host.removeGuest('guest3');
    s = await host.getState({ after: 0 });
    assert.equal(s.selectedMatch, a);
    assert.equal(s.media.videoId, 'abcdefghijk');
    assert.equal(s.notice.kind, 'left_after_match');
    assert.deepEqual(s.participants.map((p) => p.id), ['host', 'guest', 'guest2']);
    assert.equal((await d.getState({ after: 0 })).status, 'guest_removed');
    // nova rodada, depois uma saída voluntária antes do match
    await host.startRound('recommend');
    const r1 = host.snapshot.round.roundNumber;
    await guests[1].getState({ after: 0 });
    await host.vote(host.snapshot.round.picks[0], 'yes');
    await guests[1].leaveRoom();
    s = await host.getState({ after: 0 });
    assert.equal(s.round.roundNumber, r1 + 1);
    assert.deepEqual(s.round.participants, ['host', 'guest']);
    assert.equal(s.notice.reason, 'left');
    assert.deepEqual(s.round.votes.host, {});
    await assert.rejects(guests[1].getState({ after: 0 }).then((g) => assert.equal(g.status, 'guest_left')).then(() => guests[1].vote(a, 'yes')));
  } finally { await env.stop(); }
});

test('entrada tardia depois do match mantém título e mídia e fica marcada como tardia', async () => {
  const env = await boot();
  try {
    const { host, clients, guests } = await fill(env, 2);
    await host.selectPlatform('netflix');
    await host.startRound('surprise');
    const [a] = host.snapshot.round.picks;
    await guests[0].getState({ after: 0 });
    await host.vote(a, 'yes'); await guests[0].vote(a, 'yes');
    await host.selectNetflixTitle(a, '80057281');
    const inv = await host.newInvite();
    const late = mk(env); await late.joinRoom(inv.invite, 'Tarde'); await host.approveGuest('guest2');
    const s = await late.getState({ after: 0 });
    assert.equal(s.selectedMatch, a);
    assert.equal(s.media.watchId, '80057281');
    assert.deepEqual(s.round.late, ['guest2']);
    assert.equal(s.notice.kind, 'joined_after_match');
    await assert.rejects(late.vote(a, 'yes'), (e) => e.code === 'round_locked');   // não vota em rodada que já fechou
    await late.playbackNetflix(a, '80057281', 'pause', 5);                           // mas controla a mídia
    assert.equal((await host.getState({ after: 0 })).playback.updatedBy, 'guest2');
  } finally { await env.stop(); }
});

test('desconexão não exclui ninguém em silêncio; reconexão mantém a mesma identidade', async () => {
  const env = await boot();
  try {
    const { host, clients, guests } = await fill(env, 4);
    await host.selectPlatform('youtube');
    await host.startRound('surprise');
    const [a] = host.snapshot.round.picks;
    await sync(...clients);
    await host.vote(a, 'yes'); await guests[0].vote(a, 'yes'); await guests[1].vote(a, 'yes');
    // guest3 some por muito tempo (sem requisições)
    env.clock.t += 120_000;
    await host.getState({ after: 0 });
    const s = await host.getState({ after: 0 }).catch(() => host.snapshot);
    const snap = host.snapshot;
    assert.equal(snap.presence.guest3, false);
    assert.equal(snap.presence.host, true);
    assert.equal(snap.round.participants.includes('guest3'), true);            // continua na rodada
    assert.equal(snap.selectedMatch, null);                                    // 3/4 não vira match
    assert.deepEqual(snap.participants.map((p) => p.id), ['host', 'guest', 'guest2', 'guest3']);
    // reconecta com a credencial guardada: mesma identidade, mesmo seq, o voto vale
    const saved = guests[2].exportSession();
    const back = mk(env); back.resume(saved);
    const rs = await back.getState({ after: 0 });
    assert.equal(rs.you, 'guest3');
    await back.vote(a, 'yes');
    const final = await host.getState({ after: 0 });
    assert.equal(final.selectedMatch, a);
    assert.equal(final.presence.guest3, true);
    assert.equal(final.round.roundNumber, 1);                                   // nada reiniciou
    // sessão substituída: uma segunda aba da mesma credencial toma o lugar da primeira
    const dup = mk(env); dup.resume(saved);
    await assert.rejects(Promise.all([back.getState({ after: 99, wait: 5 }), dup.getState({ after: 99, wait: 1 })]), (e) => e.code === 'session_replaced');
  } finally { await env.stop(); }
});

test('isolamento: credencial de uma sala/participante não age por outro nem por sala alheia', async () => {
  const env = await boot();
  try {
    const A = await fill(env, 4);
    const B = await fill(env, 2, { names: ['Zoe', 'Ze'] });
    const tg = A.guests[2].exportSession().token;
    // remover alguém exige ser o Host
    assert.equal((await jsonPost(env, `/v1/rooms/${A.host.code}/admission`, tg, { decision: 'remove', participant: 'guest' })).status, 403);
    // token de B não abre A
    const tb = B.host.exportSession().token;
    assert.equal((await jsonPost(env, `/v1/rooms/${A.host.code}/actions`, tb, { v: 1, clientSeq: 1, type: 'viewing', payload: { titleId: 'noite', progress: 1, rating: 0, listed: false } })).status, 401);
    // convidado não gera convite, não fecha a sala e o Host não "sai"
    for (const p of ['invite', 'close']) assert.equal((await jsonPost(env, `/v1/rooms/${A.host.code}/${p}`, tg, {})).status, 403);
    assert.equal((await jsonPost(env, `/v1/rooms/${A.host.code}/leave`, A.host.exportSession().token, {})).status, 403);
    // removido não age mais e o token fica inútil quando a vaga é reocupada
    await A.host.removeGuest('guest2');
    await assert.rejects(A.guests[1].setViewing('noite', { progress: 1 }), (e) => e.status === 409 || e.status === 403);
    const inv = await A.host.newInvite();
    const novo = mk(env); await novo.joinRoom(inv.invite, 'Novo'); await A.host.approveGuest(novo.role);
    assert.equal(novo.role, 'guest2');
    await assert.rejects(A.guests[1].getState({ after: 0 }), (e) => e.status === 401);
    // viewing de cada um fica no próprio nome
    await novo.getState({ after: 0 });
    await novo.setViewing('noite', { progress: 33, rating: 1, listed: true });
    const s = await A.host.getState({ after: 0 });
    assert.equal(s.viewing.guest2.noite.progress, 33);
    assert.equal(s.viewing.guest3.noite, undefined);
  } finally { await env.stop(); }
});

test('capacidade padrão continua sendo a dupla; capacidade inválida é recusada', async () => {
  const env = await boot();
  try {
    const host = mk(env);
    const c = await host.createRoom('Ana');
    await mk(env).joinRoom(c.invite, 'Beto'); await host.approveGuest();
    await assert.rejects(host.newInvite(), (e) => e.code === 'guest_present');
    assert.equal((await host.getState({ after: 0 })).capacity, 2);
    for (const bad of [1, 5, 2.5, '4']) {
      await assert.rejects(mk(env).createRoom('Xis', { maxParticipants: bad }), (e) => e.code === 'bad_capacity');
    }
  } finally { await env.stop(); }
});

test('voz 1:1 legada continua válida; com mais de duas pessoas a sinalização exige destino e é só do par', async () => {
  const env = await boot();
  try {
    const { host, clients, guests } = await fill(env, 3);
    await Promise.all(clients.map((c) => c.voiceReady(true)));
    let s = await host.getState({ after: 0 });
    assert.equal(s.voice.links.length, 2);
    const hostToGuest = s.voice.links.find((l) => l.peer === 'guest');
    const OFFER = 'v=0\r\no=host-guest 1 1 IN IP4 127.0.0.1\r\n';
    await assert.rejects(host.voiceOffer(hostToGuest.session, OFFER), (e) => e.code === 'voice_target_required');
    await assert.rejects(host.voiceOffer(hostToGuest.session, OFFER, 'host'), (e) => e.code === 'voice_peer_unavailable');
    await assert.rejects(guests[0].voiceOffer(hostToGuest.session, OFFER, 'host'), (e) => e.code === 'wrong_role');   // o menor índice oferece
    await host.voiceOffer(hostToGuest.session, OFFER, 'guest');
    const g2 = await guests[1].getState({ after: 0 });
    assert.ok(!JSON.stringify(g2.voice).includes('host-guest'));         // guest2 não vê o par host|guest
    const g1 = await guests[0].getState({ after: 0 });
    assert.equal(g1.voice.links.find((l) => l.peer === 'host').remote.sdp, OFFER);
    const link = g1.voice.links.find((l) => l.peer === 'host');
    await guests[0].voiceAnswer(link.session, 'v=0\r\no=answer 1 1 IN IP4 127.0.0.1\r\n', 'host');
    // um par que muda não derruba os outros: guest2 sai da voz, host|guest segue
    await guests[1].voiceReady(false);
    s = await host.getState({ after: 0 });
    assert.equal(s.voice.links.find((l) => l.peer === 'guest').hasAnswer, true);
    assert.equal(s.voice.links.some((l) => l.peer === 'guest2'), false);
    await assert.rejects(host.voiceOffer(1, OFFER, 'guest2'), (e) => e.code === 'voice_not_ready');
    // remover alguém limpa a voz dele
    await host.removeGuest('guest');
    s = await host.getState({ after: 0 });
    assert.equal(s.voice.ready.guest, false);
    assert.equal(s.voice.links.some((l) => l.peer === 'guest'), false);
  } finally { await env.stop(); }
});

// ---------- voz WebRTC (malha) com 4 clientes e pares simulados ----------
test('voz em malha: 4 participantes negociam 6 ligações e cada um só recebe o SDP dos próprios pares', async () => {
  const old = { document: globalThis.document, navigator: globalThis.navigator, RTCPeerConnection: globalThis.RTCPeerConnection };
  const pcs = [];
  let seq = 0;
  class FakePC extends EventTarget {
    constructor() { super(); this.iceGatheringState = 'complete'; this.signalingState = 'stable'; this.connectionState = 'new'; this.owner = FakePC.current; pcs.push(this); }
    addTrack() {}
    createOffer() { return Promise.resolve({ type: 'offer', sdp: `v=0\r\no=offer-${++seq} ${this.owner}\r\n` }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: `v=0\r\no=answer-${++seq} ${this.owner}\r\n` }); }
    async setLocalDescription(v) { this.localDescription = v; this.signalingState = v.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(v) { this.remoteDescription = v; this.signalingState = 'stable'; this.connectionState = 'connected'; this.dispatchEvent(new Event('connectionstatechange')); }
    close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
  }
  const audios = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => { const a = { setAttribute() {}, play: async () => {}, volume: 1, srcObject: null }; audios.push(a); return a; } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => { const track = { enabled: true, stop() { this.stopped = true; } }; return { getTracks: () => [track], getAudioTracks: () => [track] }; } } } });
  globalThis.RTCPeerConnection = FakePC;
  const env = await boot();
  try {
    const { host, clients } = await fill(env, 4);
    const calls = clients.map((c) => { const v = new VoiceCall(); v.attach(c); return v; });
    const sent = [];
    clients.forEach((c, i) => {
      for (const kind of ['voiceOffer', 'voiceAnswer']) {
        const orig = c[kind].bind(c);
        c[kind] = (session, sdp, to) => { sent.push({ from: c.role, to, sdp }); return orig(session, sdp, to); };
      }
    });
    const pump = async () => { for (const [i, c] of clients.entries()) { FakePC.current = c.role; await c.getState({ after: 0 }); calls[i].update(c.snapshot); } };
    for (const [i, v] of calls.entries()) { FakePC.current = clients[i].role; await v.join(); await pump(); }
    for (let k = 0; k < 40; k++) { await pump(); await new Promise((r) => setTimeout(r, 5)); if (calls.every((v) => v.peers.size === 3 && [...v.peers.values()].every((p) => p.pc?.remoteDescription))) break; }
    for (const [i, v] of calls.entries()) {
      assert.equal(v.peers.size, 3, clients[i].role);
      for (const [peer, p] of v.peers) assert.ok(p.pc.remoteDescription, `${clients[i].role} ↔ ${peer}`);
    }
    assert.equal(sent.filter((x) => x.sdp.includes('offer-')).length, 6);
    assert.equal(sent.filter((x) => x.sdp.includes('answer-')).length, 6);
    // o SDP de um par nunca aparece no snapshot de quem não é ponta
    for (const [i, c] of clients.entries()) {
      const mine = JSON.stringify(c.snapshot.voice);
      for (const m of sent) if (m.from !== c.role && m.to !== c.role) assert.ok(!mine.includes(m.sdp.split('\r\n')[1]), `${c.role} viu SDP de ${m.from}→${m.to}`);
    }
    assert.ok(audios.length >= 4);                                  // um elemento de áudio por ligação
    assert.equal(calls[0].state, 'connected');
    // uma pessoa sai: as demais continuam com as ligações entre si
    await calls[3].leave();
    await pump();
    assert.equal(calls[0].peers.size, 2);
    assert.equal(calls[0].peers.has('guest3'), false);
    assert.ok(calls[0].peers.get('guest').pc?.remoteDescription);
    calls[1].setVolume(0.3);
    assert.ok([calls[1].audio, ...calls[1].spareAudio].every((a) => a.volume === 0.3));
    for (const v of calls) v.closeLocal();
  } finally {
    await env.stop();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key]; else Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  }
});
