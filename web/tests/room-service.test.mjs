import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient, RoomError } = require('../server/client.js');

async function boot(opts = {}) {
  const clock = { t: 1_000_000 };
  const logs = [];
  const svc = createRoomService({ now: () => clock.t, logger: (e) => logs.push(e), ...opts });
  const addr = await svc.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${addr.port}`;
  return { svc, url, clock, logs, port: addr.port, stop: () => svc.close() };
}

async function pair(env, { approve = true } = {}) {
  const host = new DuoRoomClient({ serviceUrl: env.url });
  const guest = new DuoRoomClient({ serviceUrl: env.url });
  const created = await host.createRoom();
  await guest.joinRoom(created.invite);
  if (approve) await host.approveGuest();
  return { host, guest, created };
}

const raw = (env, method, path, { headers = {}, body } = {}) => fetch(env.url + path, { method, headers, body }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), headers: r.headers }));
const jsonPost = (env, path, token, body, extra = {}) => raw(env, 'POST', path, { headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('dois clientes: criar, entrar, aprovar e compartilhar um snapshot canônico', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env);
    assert.equal(host.role, 'host');
    assert.equal(guest.role, 'guest');
    const s0 = await host.getState({ after: 0 });
    assert.equal(s0.status, 'active');
    await host.selectPlatform('youtube');
    await host.startRound('surprise');
    const round = host.snapshot.round;
    assert.equal(round.picks.length, 3);
    const gs = await guest.getState({ after: 0 });
    assert.deepEqual(gs.round.picks, round.picks);
    const [a] = round.picks;
    await host.vote(a, 'yes');
    await guest.vote(a, 'yes');
    const final = await host.getState({ after: 0 });
    assert.equal(final.selectedMatch, a);
    assert.equal(final.round.votes.host[a], 'yes');
    assert.equal(final.round.votes.guest[a], 'yes');
    await host.selectYouTubeVideo(a, 'abcdefghijk');
    assert.equal(host.snapshot.playback.state, 'playing');
    assert.equal(host.snapshot.playback.positionSec, 0);
    await guest.getState({ after: 0 });
    await guest.playback(a, 'play', 12);
    await host.setViewing(a, { progress: 40, rating: 1, listed: true });
    await guest.setViewing(a, { progress: 30, rating: 0, listed: false });
    const h = await host.getState({ after: 0 });
    assert.equal(h.playback.titleId, a);
    assert.equal(h.playback.videoId, 'abcdefghijk');
    assert.equal(h.playback.state, 'playing');
    assert.equal(h.playback.positionSec, 12);
    assert.equal(h.playback.updatedBy, 'guest');
    assert.equal(h.viewing.host[a].progress, 40);
    assert.equal(h.viewing.guest[a].progress, 30);
    const g = await guest.getState({ after: 0 });
    assert.equal(g.revision, h.revision);
    assert.deepEqual(g.round, h.round);
    assert.equal(g.you, 'guest');
    assert.equal(g.inviteState, undefined); // visão do Convidado não vê dados do convite
    // nenhum snapshot contém credenciais
    const blob = JSON.stringify([h, g]);
    for (const secret of [host.exportSession().token, guest.exportSession().token]) assert.ok(!blob.includes(secret));
    // match trava a rodada
    await assert.rejects(host.vote(a, 'no'), (e) => e.code === 'round_locked');
  } finally { await env.stop(); }
});

test('catálogo injetado usa o mesmo ID TMDB na interface e na sala', async () => {
  const catalog = [{ id: 'tmdb:movie:42', title: 'Um filme', kind: 'Filme', service: 'TMDB', genre: 'Drama', minutes: null,
    image: 'https://image.tmdb.org/t/p/w342/poster.jpg', description: 'Teste', tags: ['drama'], warmth: 2, adventure: 2,
    watchProviders: ['Netflix'], watchUrl: 'https://www.themoviedb.org/movie/42/watch?locale=BR' }];
  const env = await boot({ catalog, catalogSource: 'tmdb', servePrototype: true });
  try {
    const script = await fetch(env.url + '/src/catalog.js').then((r) => r.text());
    assert.ok(script.includes('tmdb:movie:42'));
    assert.ok(script.includes('window.DuoCatalogSource="tmdb"'));
    const { host } = await pair(env);
    await host.startRound('surprise');
    assert.deepEqual(host.snapshot.round.picks, ['tmdb:movie:42']);
    await host.setViewing('tmdb:movie:42', { progress: 100, rating: 1, listed: false });
    assert.equal((await host.getState({ after: 0 })).viewing.host['tmdb:movie:42'].progress, 100);
  } finally { await env.stop(); }
});

test('plataforma compartilhada filtra sugestões e impede mídia sem match ou serviço correto', async () => {
  const item = (id, provider) => ({ id: `tmdb:movie:${id}`, title: `Filme ${id}`, kind: 'Filme', service: 'TMDB', genre: 'Drama', minutes: 90,
    image: 'https://image.tmdb.org/t/p/w342/poster.jpg', description: 'Teste', tags: ['drama'], warmth: 2, adventure: 2,
    watchProviders: [provider], watchUrl: `https://www.themoviedb.org/movie/${id}/watch?locale=BR` });
  const env = await boot({ catalog: [item(42, 'Netflix'), item(43, 'YouTube grátis')], catalogSource: 'tmdb' });
  try {
    const { host, guest } = await pair(env);
    await assert.rejects(guest.selectPlatform('youtube'), (e) => e.code === 'wrong_role');
    await host.selectPlatform('youtube');
    assert.equal((await guest.getState({ after: 0 })).platform, 'youtube');
    await assert.rejects(guest.pickManually('tmdb:movie:42'), (e) => e.code === 'title_not_on_platform');
    await host.startRound('surprise');
    assert.deepEqual(host.snapshot.round.picks, ['tmdb:movie:43']);
    await assert.rejects(host.selectYouTubeVideo('tmdb:movie:43', 'abcdefghijk'), (e) => e.code === 'no_match');
    await host.vote('tmdb:movie:43', 'yes');
    await guest.getState({ after: 0 });
    await guest.vote('tmdb:movie:43', 'yes');
    await host.getState({ after: 0 });
    await guest.selectYouTubeVideo('tmdb:movie:43', 'abcdefghijk');
    assert.equal(guest.snapshot.media.videoId, 'abcdefghijk');
    assert.equal(guest.snapshot.playback.state, 'playing');
    await host.getState({ after: 0 });
    await host.selectPlatform('netflix');
    assert.equal(host.snapshot.round, null);
    assert.equal(host.snapshot.media, null);
    assert.equal(host.snapshot.playback, null);
  } finally { await env.stop(); }
});

test('busca do YouTube usa chave apenas no servidor e requer sala ativa', async () => {
  const requests = [];
  const key = 'A'.repeat(30);
  const env = await boot({ youtubeApiKey: key, fetchImpl: async (url) => {
    requests.push(new URL(url));
    return { ok: true, json: async () => ({ items: [{ id: { videoId: 'abcdefghijk' }, snippet: { title: '<vídeo de teste>', channelTitle: 'Canal' } }] }) };
  } });
  try {
    const { host, guest } = await pair(env);
    assert.equal(host.snapshot, null);
    await assert.rejects(host.searchYouTube('filme'), (e) => e.code === 'wrong_platform');
    await host.selectPlatform('youtube');
    assert.equal((await guest.getState({ after: 0 })).youtubeSearchEnabled, true);
    const results = await guest.searchYouTube('filme');
    assert.equal(results[0].videoId, 'abcdefghijk');
    assert.equal(results[0].thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
    assert.equal(requests[0].hostname, 'www.googleapis.com');
    assert.equal(requests[0].searchParams.get('key'), key);
    assert.equal(requests[0].searchParams.get('videoEmbeddable'), 'true');
    assert.ok(!JSON.stringify(results).includes(key));
    assert.ok(!JSON.stringify(await host.getState({ after: 0 })).includes(key));
  } finally { await env.stop(); }
});

test('vídeo direto do YouTube abre para ambos sem voto extra após a entrada', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env);
    await host.selectPlatform('youtube');
    await guest.getState({ after: 0 });
    await guest.openYouTubeVideo('abcdefghijk', 'Vídeo de teste');
    const opened = await host.getState({ after: 0 });
    assert.deepEqual(opened.media, { provider: 'youtube', titleId: 'youtube:abcdefghijk', videoId: 'abcdefghijk', title: 'Vídeo de teste' });
    assert.equal(opened.playback.state, 'playing');
    assert.equal(opened.playback.positionSec, 0);
    assert.equal(opened.playback.updatedBy, 'guest');
    assert.equal(opened.videoProposal, undefined);
    await assert.rejects(host.send('video.vote', { videoId: 'abcdefghijk', vote: 'yes' }), (e) => e.code === 'unknown_type');
    await host.playback('youtube:abcdefghijk', 'play', 7);
    assert.equal((await guest.getState({ after: 0 })).playback.positionSec, 7);
    await host.openYouTubeVideo('123456789ab', 'Próximo vídeo');
    assert.equal((await guest.getState({ after: 0 })).media.videoId, '123456789ab');
    await host.selectPlatform('netflix');
    assert.equal(host.snapshot.media, null);
    await assert.rejects(guest.openYouTubeVideo('abcdefghijk', 'Outro vídeo'), (e) => e.code === 'wrong_platform');
  } finally { await env.stop(); }
});

test('voz troca SDP apenas entre participantes aprovados e limpa sinais ao sair', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env, { approve: false });
    await assert.rejects(host.voiceReady(true), (e) => e.code === 'not_active');
    await host.approveGuest();
    await host.voiceReady(true);
    await guest.getState({ after: 0 });
    await guest.voiceReady(true);
    const h = await host.getState({ after: 0 });
    const session = h.voice.session;
    assert.deepEqual(h.voice.ready, { host: true, guest: true });
    assert.equal(h.voice.remote, null);
    const offer = 'v=0\r\no=host 1 1 IN IP4 127.0.0.1\r\n';
    const answer = 'v=0\r\no=guest 1 1 IN IP4 127.0.0.1\r\n';
    await assert.rejects(guest.voiceOffer(session, offer), (e) => e.code === 'wrong_role');
    await host.voiceOffer(session, offer);
    const g = await guest.getState({ after: 0 });
    assert.deepEqual(g.voice.remote, { session, sdp: offer });
    assert.equal(host.snapshot.voice.remote, null);
    await guest.voiceAnswer(session, answer);
    assert.deepEqual((await host.getState({ after: 0 })).voice.remote, { session, sdp: answer });
    assert.equal(guest.snapshot.voice.remote.sdp, offer);
    await assert.rejects(host.voiceOffer(session, offer), (e) => e.code === 'stale_voice_session');
    await guest.voiceReady(false);
    const stopped = await host.getState({ after: 0 });
    assert.equal(stopped.voice.ready.guest, false);
    assert.equal(stopped.voice.remote, null);
    assert.equal(stopped.voice.hasOffer, false);
    assert.equal(stopped.voice.hasAnswer, false);
    await assert.rejects(host.voiceOffer(session, offer), (e) => e.code === 'voice_not_ready');
  } finally { await env.stop(); }
});

test('voz rejeita SDP excessivo e sessões antigas; reiniciar chamada não pede aprovação', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env);
    await host.voiceReady(true);
    await guest.voiceReady(true);
    const session = (await host.getState({ after: 0 })).voice.session;
    await assert.rejects(host.voiceOffer(session, 'v=0\r\n' + 'a'.repeat(25000)), (e) => e.code === 'bad_payload');
    await guest.voiceRetry();
    const fresh = (await host.getState({ after: 0 })).voice.session;
    assert.ok(fresh > session);
    await assert.rejects(host.voiceOffer(session, 'v=0\r\n'), (e) => e.code === 'stale_voice_session');
    await host.voiceOffer(fresh, 'v=0\r\n');
    assert.equal((await guest.getState({ after: 0 })).voice.remote.session, fresh);
  } finally { await env.stop(); }
});

test('catálogo injetado rejeita imagem ou link que poderiam executar conteúdo no navegador', () => {
  const base = { id: 'tmdb:movie:42', image: 'https://image.tmdb.org/t/p/w342/poster.jpg' };
  assert.throws(() => createRoomService({ catalog: [{ ...base, image: "x');background:url(https://evil.example)" }] }), /invalid_catalog_item/);
  assert.throws(() => createRoomService({ catalog: [{ ...base, tmdbUrl: 'javascript:alert(1)' }] }), /invalid_catalog_item/);
  assert.throws(() => createRoomService({ catalog: [{ ...base, watchProviders: ['Netflix'], watchUrl: 'https://evil.example' }], catalogSource: 'tmdb' }), /invalid_catalog_item/);
});

test('nomes de Perfil acompanham a sala, sem alterar os papéis autenticados', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url });
    const guest = new DuoRoomClient({ serviceUrl: env.url });
    await assert.rejects(host.createRoom('<script>'), (e) => e.code === 'bad_display_name');
    const created = await host.createRoom('Daniel');
    await assert.rejects(guest.joinRoom(created.invite, 'Nome\nruim'), (e) => e.code === 'bad_display_name');
    await guest.joinRoom(created.invite, 'Larissa');
    const pendingHost = await host.getState({ after: 0 });
    assert.equal(pendingHost.pendingGuest.displayName, 'Larissa');
    const pendingGuest = await guest.getState({ after: 0 });
    assert.equal(pendingGuest.names, undefined);
    await host.approveGuest();
    assert.deepEqual((await guest.getState({ after: 0 })).names, { host: 'Daniel', guest: 'Larissa' });
    await guest.setDisplayName('Lari');
    assert.equal((await host.getState({ after: 0 })).names.guest, 'Lari');
    assert.equal(guest.role, 'guest');
    assert.equal((await jsonPost(env, `/v1/rooms/${host.code}/profile`, guest.exportSession().token, { displayName: '<script>' })).status, 400);
    assert.equal((await jsonPost(env, `/v1/rooms/${host.code}/profile`, null, { displayName: 'Invasor' })).status, 401);
  } finally { await env.stop(); }
});

test('long polling acorda quando o parceiro age; loop start() recebe snapshots', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env);
    await host.getState({ after: 0 });
    const waiting = host.getState({ wait: 10 });
    setTimeout(() => guest.setViewing('noite', { progress: 10 }), 50);
    const snap = await waiting;
    assert.equal(snap.viewing.guest.noite.progress, 10);

    const seen = [];
    const statuses = [];
    guest.start({ onSnapshot: (s) => seen.push(s.revision), onStatus: (s) => statuses.push(s), waitSec: 5 });
    await host.startRound('recommend');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(seen.length >= 2 && seen.at(-1) === host.revision);
    await host.closeRoom();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(statuses.at(-1), 'ended');
  } finally { await env.stop(); }
});

test('credencial e papel: convidado não é host, papel declarado é recusado, host token nunca vai ao convidado', async () => {
  const env = await boot();
  try {
    const { host, guest, created } = await pair(env);
    await host.startRound('surprise');
    const code = host.code;
    const gTok = guest.exportSession().token, hTok = host.exportSession().token;
    assert.notEqual(gTok, hTok);
    // convidado tenta ação de host
    const r1 = await jsonPost(env, `/v1/rooms/${code}/actions`, gTok, { v: 1, clientSeq: 1, type: 'round.start', payload: { mode: 'surprise' } });
    assert.equal(r1.status, 403);
    assert.equal(r1.json.error, 'wrong_role');
    // convidado tenta admissão/convite/fechar
    for (const p of ['admission', 'invite', 'close']) assert.equal((await jsonPost(env, `/v1/rooms/${code}/${p}`, gTok, p === 'admission' ? { decision: 'remove' } : {})).status, 403);
    // papel declarado em qualquer lugar do envelope
    for (const extra of [{ role: 'host' }, { from: 'host' }, { host: true }, { token: hTok }]) {
      const r = await jsonPost(env, `/v1/rooms/${code}/actions`, gTok, { v: 1, clientSeq: 1, type: 'viewing', payload: { titleId: 'noite', progress: 1, rating: 0, listed: false }, ...extra });
      assert.equal(r.status, 400); assert.equal(r.json.error, 'declared_identity');
    }
    // payload com campo extra
    const r2 = await jsonPost(env, `/v1/rooms/${code}/actions`, gTok, { v: 1, clientSeq: 1, type: 'viewing', payload: { titleId: 'noite', progress: 1, rating: 0, listed: false, role: 'host' } });
    assert.equal(r2.status, 400);
    // convidado nunca recebeu a credencial do host: resposta de join só tem guestToken
    assert.ok(!JSON.stringify(created).includes(gTok));
  } finally { await env.stop(); }
});

test('código público não autoriza; token de outra sala não acessa; sem token é 401', async () => {
  const env = await boot();
  try {
    const a = await pair(env), b = await pair(env);
    const tokB = b.host.exportSession().token;
    assert.equal((await raw(env, 'GET', `/v1/rooms/${a.host.code}/state`)).status, 401);
    assert.equal((await raw(env, 'GET', `/v1/rooms/${a.host.code}/state`, { headers: { Authorization: 'Bearer ' + tokB } })).status, 401);
    assert.equal((await raw(env, 'GET', `/v1/rooms/000000/state`, { headers: { Authorization: 'Bearer ' + tokB } })).status, 401);
    assert.equal((await jsonPost(env, `/v1/rooms/${a.host.code}/actions`, tokB, { v: 1, clientSeq: 1, type: 'viewing', payload: { titleId: 'noite', progress: 1, rating: 0, listed: false } })).status, 401);
    // entrar só com o código (segredo de outra sala) falha de forma uniforme
    const secretB = DuoRoomClient.decodeInvite(b.created.invite).inviteSecret;
    const j = await jsonPost(env, `/v1/rooms/${a.host.code}/join`, null, { inviteSecret: secretB });
    assert.equal(j.status, 403); assert.equal(j.json.error, 'invalid_invite');
    const j2 = await jsonPost(env, `/v1/rooms/999999/join`, null, { inviteSecret: secretB });
    assert.equal(j2.status, 403); assert.equal(j2.json.error, 'invalid_invite');
  } finally { await env.stop(); }
});

test('token na URL é recusado e nada sensível aparece no log', async () => {
  const logs = [];
  const env = await boot({ logger: (e) => logs.push(e) });
  try {
    const { host, guest } = await pair(env);
    const tok = host.exportSession().token;
    const r = await raw(env, 'GET', `/v1/rooms/${host.code}/state?token=${tok}`, { headers: { Authorization: 'Bearer ' + tok } });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'credentials_in_url_forbidden');
    await assert.rejects(guest.getState({ after: 0, wait: 0 }).then(() => guest.admission('approve')), RoomError);
    const logText = JSON.stringify(logs);
    assert.ok(!logText.includes(tok) && !logText.includes(guest.exportSession().token));
    assert.ok(logs.every((e) => Object.keys(e).sort().join() === 'method,route,status'));
  } finally { await env.stop(); }
});

test('convite: uso único, terceiro recusado, convidado duplicado recusado, aprovação do host exigida', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url });
    const created = await host.createRoom();
    const g1 = new DuoRoomClient({ serviceUrl: env.url });
    await g1.joinRoom(created.invite);
    // antes da aprovação: convidado não age nem vê a sala
    const pend = await g1.getState({ after: 0 });
    assert.equal(pend.status, 'pending_approval');
    assert.equal(pend.round, undefined);
    await assert.rejects(g1.setViewing('noite', { progress: 5 }), (e) => e.code === 'not_active');
    const hs = await host.getState({ after: 0 });
    assert.equal(hs.status, 'pending_approval');
    assert.ok(hs.pendingGuest);
    // replay do convite: usado
    const g2 = new DuoRoomClient({ serviceUrl: env.url });
    await assert.rejects(g2.joinRoom(created.invite), (e) => e.code === 'invite_used');
    await host.approveGuest();
    await assert.rejects(g2.joinRoom(created.invite), (e) => e.code === 'invite_used');
    // novo convite com convidado presente: recusado (vaga única)
    await assert.rejects(host.newInvite(), (e) => e.code === 'guest_present');
    // remover libera a vaga, invalida o token antigo e permite novo convite
    await host.removeGuest();
    const removed = await g1.getState({ after: 0 });
    assert.equal(removed.status, 'guest_removed');
    const inv = await host.newInvite();
    const g3 = new DuoRoomClient({ serviceUrl: env.url });
    await g3.joinRoom(inv.invite);
    await host.approveGuest();
    await assert.rejects(g1.getState({ after: 0 }), (e) => e.status === 401); // token antigo morreu
    assert.equal((await g3.getState({ after: 0 })).status, 'active');
  } finally { await env.stop(); }
});

test('host nega: convidado fica fora e convite queimado exige novo convite', async () => {
  const env = await boot();
  try {
    const { host, guest, created } = await pair(env, { approve: false });
    await host.denyGuest();
    assert.equal((await guest.getState({ after: 0 })).status, 'guest_denied');
    await assert.rejects(guest.setViewing('noite', { progress: 1 }), (e) => e.status === 409 || e.status === 403);
    await assert.rejects(new DuoRoomClient({ serviceUrl: env.url }).joinRoom(created.invite), (e) => e.code === 'invite_used');
  } finally { await env.stop(); }
});

test('tentativas erradas não bloqueiam o convidado legítimo; expiração de convite, aprovação pendente e sala', async () => {
  const env = await boot({ inviteTtlMs: 1000, pendingTtlMs: 5000, roomTtlMs: 20000, closedGraceMs: 100 });
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url });
    const created = await host.createRoom();
    const { code, inviteSecret } = DuoRoomClient.decodeInvite(created.invite);
    // convite expirado (segredo correto)
    env.clock.t += 1500;
    let r = await jsonPost(env, `/v1/rooms/${code}/join`, null, { inviteSecret });
    assert.equal(r.status, 409); assert.equal(r.json.error, 'invite_expired');
    assert.equal((await host.getState({ after: 0 })).inviteState, 'expired');
    // Um terceiro não pode derrubar o convite legítimo com cinco tentativas erradas.
    const inv = await host.newInvite();
    const wrong = 'A'.repeat(43);
    for (let i = 0; i < 5; i++) assert.equal((await jsonPost(env, `/v1/rooms/${code}/join`, null, { inviteSecret: wrong })).status, 403);
    assert.equal((await host.getState({ after: 0 })).inviteState, 'valid');
    const g = new DuoRoomClient({ serviceUrl: env.url });
    await g.joinRoom(inv.invite);
    // aprovação pendente expira
    env.clock.t += 6000;
    assert.equal((await g.getState({ after: 0 })).status, 'guest_denied');
    // sala expira → 410 e depois varrida (401)
    env.clock.t += 20000;
    await assert.rejects(host.getState({ after: 0 }), (e) => e.status === 410);
    env.clock.t += 500;
    env.svc.sweep();
    await assert.rejects(host.getState({ after: 0 }), (e) => e.status === 401);
    assert.equal(env.svc.stats().rooms, 0);
  } finally { await env.stop(); }
});

test('seq: duplicado é idempotente, antigo é stale, inválido não consome seq, rodada antiga é recusada', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env);
    await host.startRound('surprise');
    const code = host.code, hTok = host.exportSession().token;
    const roundNo = host.snapshot.round.roundNumber;
    const [a, b] = host.snapshot.round.picks;
    const act = (seq, type, payload) => jsonPost(env, `/v1/rooms/${code}/actions`, hTok, { v: 1, clientSeq: seq, type, payload });
    // host já usou seq 1 (round.start)
    const v1 = await act(2, 'vote', { round: roundNo, titleId: a, vote: 'no' });
    assert.equal(v1.status, 200); assert.equal(v1.json.duplicate, false);
    const rev = v1.json.revision;
    const dup = await act(2, 'vote', { round: roundNo, titleId: a, vote: 'no' }); // mesmo seq, mesmo conteúdo
    assert.equal(dup.status, 200); assert.equal(dup.json.duplicate, true); assert.equal(dup.json.revision, rev);
    const conflict = await act(2, 'vote', { round: roundNo, titleId: a, vote: 'yes' });
    assert.equal(conflict.status, 409); assert.equal(conflict.json.error, 'seq_conflict');
    assert.equal((await host.getState({ after: 0 })).round.votes.host[a], 'no'); // não reaplicou
    const stale = await act(1, 'vote', { round: roundNo, titleId: b, vote: 'yes' });
    assert.equal(stale.status, 409); assert.equal(stale.json.error, 'stale_seq');
    // inválido (título desconhecido) não consome o seq 3
    const unk = await act(3, 'vote', { round: roundNo, titleId: 'nao-existe', vote: 'yes' });
    assert.equal(unk.status, 400); assert.equal(unk.json.error, 'unknown_title');
    const ok3 = await act(3, 'vote', { round: roundNo, titleId: b, vote: 'yes' });
    assert.equal(ok3.status, 200); assert.equal(ok3.json.duplicate, false);
    // título que existe no catálogo mas fora da rodada
    const outside = (await import('node:module')).createRequire(import.meta.url)('../src/catalog.js').map((c) => c.id).find((id) => !host.snapshot.round.picks.includes(id));
    const out = await act(4, 'vote', { round: roundNo, titleId: outside, vote: 'yes' });
    assert.equal(out.status, 400);
    // nova rodada invalida votos da antiga
    await host.getState({ after: 0 }); // reaproveita yourLastSeq (as ações cruas acima passaram do cliente)
    await host.startRound('surprise');
    const old = await act(Number(host.exportSession().lastSeq) + 1, 'vote', { round: roundNo, titleId: a, vote: 'yes' });
    assert.equal(old.status, 409); assert.equal(old.json.error, 'stale_round');
    // playback sem match
    const noMatch = await jsonPost(env, `/v1/rooms/${code}/actions`, guest.exportSession().token, { v: 1, clientSeq: guest.exportSession().lastSeq + 1, type: 'playback', payload: { titleId: a, videoId: 'abcdefghijk', action: 'play', positionSec: 1 } });
    assert.equal(noMatch.json.error, 'no_match');
    // tipo desconhecido, versão errada, seq inválido
    assert.equal((await act(99, 'hack', {})).json.error, 'unknown_type');
    assert.equal((await jsonPost(env, `/v1/rooms/${code}/actions`, hTok, { v: 2, clientSeq: 99, type: 'vote', payload: {} })).json.error, 'bad_version');
    assert.equal((await act(0, 'vote', {})).json.error, 'bad_seq');
    assert.equal((await act(1.5, 'vote', {})).json.error, 'bad_seq');
  } finally { await env.stop(); }
});

test('requisições malformadas, corpo grande e content-type errado', async () => {
  const env = await boot({ maxBodyBytes: 512 });
  try {
    const { host } = await pair(env);
    const tok = host.exportSession().token, p = `/v1/rooms/${host.code}/actions`;
    assert.equal((await jsonPost(env, p, tok, '{nao json')).status, 400);
    assert.equal((await jsonPost(env, p, tok, '[1,2]')).status, 400);
    assert.equal((await jsonPost(env, p, tok, '"x"')).status, 400);
    assert.equal((await jsonPost(env, p, tok, JSON.stringify({ pad: 'x'.repeat(2000) }))).status, 413);
    assert.equal((await jsonPost(env, '/v1/rooms', null, { unexpected: true })).status, 400);
    assert.equal((await jsonPost(env, `/v1/rooms/${host.code}/invite`, tok, { unexpected: true })).status, 400);
    assert.equal((await jsonPost(env, `/v1/rooms/${host.code}/close`, tok, { unexpected: true })).status, 400);
    assert.equal((await raw(env, 'POST', p, { headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await raw(env, 'GET', p, { headers: { Authorization: 'Bearer ' + tok } })).status, 405);
    assert.equal((await raw(env, 'GET', '/v1/nada')).status, 404);
    assert.equal((await raw(env, 'GET', `/v1/rooms/${host.code}/state?after=abc`, { headers: { Authorization: 'Bearer ' + tok } })).status, 400);
    assert.equal((await raw(env, 'GET', `/v1/rooms/${host.code}/state?wait=999`, { headers: { Authorization: 'Bearer ' + tok } })).status, 400);
    assert.equal((await raw(env, 'GET', `/v1/rooms/${host.code}/state`, { headers: { Authorization: 'Bearer curto' } })).status, 401);
    // corpo grande sem Content-Length (chunked)
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: env.port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve('closed'));
      req.write('{"a":"' + 'x'.repeat(2000)); req.end('"}');
    });
    assert.ok(status === 413 || status === 'closed');
    // cabeçalhos de resposta
    const h = await raw(env, 'GET', '/healthz');
    assert.equal(h.headers.get('cache-control'), 'no-store');
  } finally { await env.stop(); }
});

test('interface local é servida na mesma origem; outras origens e caminhos são recusados', async () => {
  const env = await boot({ servePrototype: true });
  try {
    const page = await fetch(env.url + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /server\/online-ui\.js/);
    assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    const scriptPolicy = page.headers.get('content-security-policy').split(';').find((x) => x.trim().startsWith('script-src'));
    assert.match(scriptPolicy, /sha256-/);
    assert.doesNotMatch(scriptPolicy, /unsafe-inline/);
    assert.equal((await fetch(env.url + '/server/online-ui.js')).status, 200);
    assert.equal((await fetch(env.url + '/server/youtube-player.js')).status, 200);
    assert.equal((await fetch(env.url + '/assets/duotela-icon.png')).status, 200);
    assert.equal((await fetch(env.url + '/server/room-service.js')).status, 404);
    assert.equal((await fetch(env.url + '/assets/%2e%2e%2fserver%2froom-service.js')).status, 404);
    assert.equal((await raw(env, 'POST', '/v1/rooms', { headers: { Origin: env.url, 'Content-Type': 'application/json' }, body: '{}' })).status, 201);
    assert.equal((await raw(env, 'POST', '/v1/rooms', { headers: { Origin: `http://localhost:${env.port}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 201);
    assert.equal((await raw(env, 'POST', '/v1/rooms', { headers: { Origin: `http://[::1]:${env.port}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 201);
    assert.equal((await raw(env, 'POST', '/v1/rooms', { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  } finally { await env.stop(); }
});

test('cliente também carrega como script de navegador sem CommonJS', async () => {
  const script = await readFile(new URL('../server/client.js', import.meta.url), 'utf8');
  const context = { self: {}, URL, Symbol, setTimeout, clearTimeout, browserFetchMarker: true };
  context.fetch = function (_url, opts) {
    if (!this.browserFetchMarker) throw new TypeError('Illegal invocation');
    assert.equal(opts.method, 'POST');
    return Promise.resolve({ ok: true, status: 201, json: async () => ({ ok: true, code: '123456', hostToken: 'h'.repeat(43), inviteSecret: 'i'.repeat(43), inviteExpiresAt: 1, roomExpiresAt: 2 }) });
  };
  vm.runInNewContext(script, context);
  assert.equal(typeof context.self.DuoRoomClient, 'function');
  assert.deepEqual({ ...context.self.DuoRoomClient.decodeInvite('123456.' + 'a'.repeat(43)) }, { code: '123456', inviteSecret: 'a'.repeat(43) });
  const browserClient = new context.self.DuoRoomClient({ serviceUrl: 'http://127.0.0.1:8787' });
  assert.equal((await browserClient.createRoom()).code, '123456');
});

test('cliente recusa snapshot cujo papel não combina com a credencial declarada ao retomar', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url });
    await host.createRoom();
    const wrong = new DuoRoomClient({ serviceUrl: env.url });
    wrong.resume({ ...host.exportSession(), role: 'guest' });
    await assert.rejects(wrong.getState({ after: 0 }), /Snapshot da sala inconsistente/);
  } finally { await env.stop(); }
});

test('Origin: recusado por padrão, permitido só na lista; preflight', async () => {
  const env = await boot({ allowedOrigins: ['https://duotela.example'] });
  try {
    assert.equal((await raw(env, 'GET', '/healthz', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await raw(env, 'POST', '/v1/rooms', { headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const ok = await raw(env, 'GET', '/healthz', { headers: { Origin: 'https://duotela.example' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://duotela.example');
    const pre = await fetch(env.url + '/v1/rooms', { method: 'OPTIONS', headers: { Origin: 'https://duotela.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
    const preBad = await fetch(env.url + '/v1/rooms', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(preBad.status, 403);
  } finally { await env.stop(); }
  const env2 = await boot();
  try { assert.equal((await raw(env2, 'GET', '/healthz', { headers: { Origin: 'http://127.0.0.1:1' } })).status, 403); } finally { await env2.stop(); }
});

test('reconexão: mesma credencial retoma; sessão duplicada substitui a anterior; resume() reaproveita seq', async () => {
  const env = await boot();
  try {
    const { host, guest } = await pair(env);
    await host.startRound('surprise');
    await guest.getState({ after: 0 });
    // dois long polls do mesmo papel: o antigo recebe 409 session_replaced
    const first = guest.getState({ after: guest.revision, wait: 10 });
    await new Promise((r) => setTimeout(r, 50));
    const other = new DuoRoomClient({ serviceUrl: env.url });
    other.resume(guest.exportSession());
    const second = other.getState({ after: guest.revision, wait: 10 });
    await assert.rejects(first, (e) => e.code === 'session_replaced');
    // enquanto o guest estava "fora", o host muda o estado; o retomado recebe cópia atual antes de agir
    await host.setViewing('noite', { progress: 55 });
    const snap = await second;
    assert.equal(snap.viewing.host.noite.progress, 55);
    // seq retomado a partir do servidor (yourLastSeq), ação repetida com seq antigo é duplicada/stale, não reaplica
    await other.setViewing('noite', { progress: 20 });
    const late = new DuoRoomClient({ serviceUrl: env.url });
    late.resume({ ...guest.exportSession(), lastSeq: 0 });
    await late.getState({ after: 0 });          // sincroniza seq com yourLastSeq
    await late.setViewing('noite', { progress: 21 });
    assert.equal((await host.getState({ after: 0 })).viewing.guest.noite.progress, 21);
    // sessão fechada pelo host → guest vê 'closed' e depois a credencial deixa de valer
    await host.closeRoom();
    assert.equal((await late.getState({ after: 0 })).status, 'closed');
    await assert.rejects(late.setViewing('noite', { progress: 22 }), (e) => e.code === 'room_closed');
  } finally { await env.stop(); }
});

test('limites: waiters globais, salas, taxa e escuta fora do loopback', async () => {
  const env = await boot({ maxWaiters: 1, maxRooms: 2, rateLimits: { create: 3 } });
  try {
    const a = await pair(env);
    await a.host.getState({ after: 0 }); await a.guest.getState({ after: 0 });
    const w1 = a.host.getState({ after: a.host.revision, wait: 5 });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(a.guest.getState({ after: a.guest.revision, wait: 5 }), (e) => e.status === 503);
    await a.host.closeRoom(); await w1.catch(() => {});
    const h2 = new DuoRoomClient({ serviceUrl: env.url });
    await h2.createRoom();
    await assert.rejects(new DuoRoomClient({ serviceUrl: env.url }).createRoom(), (e) => e.status === 503 || e.status === 429);
    await assert.rejects(new DuoRoomClient({ serviceUrl: env.url }).createRoom(), (e) => e.status === 429 || e.status === 503);
  } finally { await env.stop(); }
  const svc = createRoomService();
  await assert.rejects(svc.listen(0, '0.0.0.0'), /loopback/);
  await svc.close();
});

test('cliente: https obrigatório fora do loopback; credencial não vaza por JSON/inspect', async () => {
  assert.throws(() => new DuoRoomClient({ serviceUrl: 'http://example.com' }), /https/);
  assert.throws(() => new DuoRoomClient({ serviceUrl: 'https://example.com/?token=x' }));
  assert.doesNotThrow(() => new DuoRoomClient({ serviceUrl: 'https://example.com' }));
  assert.throws(() => DuoRoomClient.decodeInvite('123456.curto'));
  const env = await boot();
  try {
    const { host } = await pair(env);
    const tok = host.exportSession().token;
    assert.ok(!JSON.stringify(host).includes(tok));
    assert.ok(!(await import('node:util')).inspect(host, { depth: 5, showHidden: true }).includes(tok));
    assert.equal(host.toJSON().insecureTransport, true);
  } finally { await env.stop(); }
});
