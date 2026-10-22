// Integração: 4 "navegadores" simulados (aba da sala + hub + aba Netflix com <video> falso cada um)
// falando com o serviço de sala REAL por HTTP. Nada de Netflix real: o DOM e o vídeo são falsos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient } = require('../server/client.js');
const { NetflixBridge, createRoomLink } = require('../server/netflix-bridge.js');
const { createHub } = require('../extension-bridge/src/hub.js');
const { createRoomContent } = require('../extension-bridge/src/room-content.js');
const { createNetflixContent } = require('../extension-bridge/src/netflix-content.js');
const { wire, flush, makeRuntime, FakeWindow, FakeVideo, FakeDocument, makeOverlayFactory } = require('../extension-bridge/tests/helpers.cjs');

const ROOM_ORIGIN = 'http://127.0.0.1:8794';
const NF = 'https://www.netflix.com';
const WATCH = '80057281';
const until = async (check, what) => { for (let i = 0; i < 200; i++) { if (await check()) return; await flush(3); await new Promise((r) => setTimeout(r, 10)); } assert.fail('expirou: ' + what); };

/** Um navegador de uma pessoa: hub próprio, aba da sala (com credencial) e uma aba Netflix opcional. */
function browser(client, { name }) {
  const hub = createHub({ runtimeId: 'ext-' + name });
  const win = new FakeWindow(ROOM_ORIGIN);
  const csRuntime = makeRuntime(hub, { id: 'ext-' + name, tabId: 10, origin: ROOM_ORIGIN });
  const cs = createRoomContent({ window: win, runtime: csRuntime, location: win.location, setTimeoutFn: () => 0 });
  const b = { name, client, hub, win, cs, link: null, net: null, tabs: [] };
  b.bridge = new NetflixBridge({ window: win, onChange: () => {}, onEvent: (m, ack) => b.link.handleEvent(m, ack), setIntervalFn: () => 0, clearIntervalFn: () => {} });
  b.link = createRoomLink({ client, bridge: b.bridge, onApply: (s) => b.bridge.pushSnapshot(s) });
  b.bridge.start();
  b.bridge.setRoom({ code: client.code, you: client.role });
  client.start({ waitSec: 1, onSnapshot: (s) => b.bridge.pushSnapshot(s) });
  b.openNetflix = (tabId, watchId, { duration } = {}) => {
    const video = new FakeVideo({ duration });
    const doc = new FakeDocument(video);
    const location = { href: `${NF}/watch/${watchId}` };
    const overlay = makeOverlayFactory();
    const intervals = [];
    const rt = makeRuntime(hub, { id: 'ext-' + name, tabId, origin: NF, url: location.href });
    const nc = createNetflixContent({ document: doc, location, runtime: rt, setIntervalFn: (fn) => { intervals.push(fn); return 1; }, clearIntervalFn: () => {}, overlayFactory: overlay.factory });
    const tab = { tabId, video, location, overlay, nc, tick: () => intervals.forEach((f) => f()) };
    b.tabs.push(tab);
    return tab;
  };
  b.dispose = () => { client.stop(); b.bridge.stop(); cs.dispose(); for (const t of b.tabs) t.nc.dispose(); };
  return b;
}

async function room4(env) {
  const names = ['Ana', 'Beto', 'Cida', 'Davi'];
  const host = new DuoRoomClient({ serviceUrl: env.url });
  const created = await host.createRoom('Ana', { maxParticipants: 4 });
  const clients = [host];
  let invite = created.invite;
  for (let i = 1; i < 4; i++) {
    const g = new DuoRoomClient({ serviceUrl: env.url });
    await g.joinRoom(invite, names[i]);
    await host.approveGuest(g.role);
    clients.push(g);
    if (i < 3) invite = (await host.newInvite()).invite;
  }
  await Promise.all(clients.map((c) => c.getState({ after: 0 })));
  await host.selectPlatform('netflix');
  await host.startRound('surprise');
  const [titleId, other] = host.snapshot.round.picks;
  await Promise.all(clients.map((c) => c.getState({ after: 0 })));
  for (const c of clients) await c.vote(titleId, 'yes');
  await host.getState({ after: 0 });
  assert.equal(host.snapshot.selectedMatch, titleId);
  return { clients, titleId, other, names };
}

test('4 navegadores: admissão, votos, match unânime, associação Netflix e play/pause/seek para todos sem eco', async () => {
  const svc = createRoomService({ logger: () => {} });
  const addr = await svc.listen(0, '127.0.0.1');
  const env = { url: `http://127.0.0.1:${addr.port}` };
  const browsers = [];
  try {
    wire.length = 0;
    const { clients, titleId, other } = await room4(env);
    const [host, g1, g2, g3] = clients;
    for (const [i, c] of clients.entries()) browsers.push(browser(c, { name: ['ana', 'beto', 'cida', 'davi'][i] }));
    const [bHost, b1, b2, b3] = browsers;
    const tabs = browsers.map((b) => b.openNetflix(20, WATCH));
    await until(() => browsers.every((b) => b.bridge.state.connected && b.bridge.state.tabs.length === 1), 'extensão detectada e aba Netflix listada em cada navegador');

    // Antes da associação nada é sincronizado: as abas Netflix ficam quietas.
    assert.equal(tabs.every((t) => t.video.calls.length === 0), true);

    // O Host confirma que a aba aberta é o título do match. Outro título/sem match é recusado pela sala.
    await assert.rejects(host.selectNetflixTitle(other, WATCH), (e) => e.code === 'no_match');
    await bHost.link.associate(20, WATCH);
    await until(() => bHost.bridge.state.bound, 'Host associado');
    assert.deepEqual(host.snapshot.media, { provider: 'netflix', titleId, watchId: WATCH });
    await until(() => !tabs[0].video.paused, 'vídeo do Host em reprodução (a sala começa tocando em 0:00)');

    // Os outros recebem o mesmo watchId e sincronizam a própria aba com um clique (sem aprovação do Host).
    for (const b of [b1, b2, b3]) await until(() => b.client.snapshot?.media?.watchId === WATCH, `${b.name} recebeu a mídia`);
    assert.throws(() => b1.link.sync(20, '999'), /não é o título/);       // abrir outro título não vale
    for (const b of [b1, b2, b3]) b.link.sync(20, WATCH);
    await until(() => browsers.every((b) => b.bridge.state.bound), 'as 4 abas ligadas');
    await until(() => tabs.every((t) => !t.video.paused), 'as 4 abas tocando');
    const v0 = host.snapshot.playback.version;

    // Host pausa em 50 s no player da Netflix → as outras 3 abas pausam em ~50 s; uma única ação na sala.
    tabs[0].video.advance(50); tabs[0].video.pauseByUser();
    await until(() => tabs.every((t) => t.video.paused), 'todos pausados');
    assert.ok(tabs.every((t) => Math.abs(t.video.currentTime - tabs[0].video.currentTime) < 2.5));
    await flush(20);
    assert.equal(g3.snapshot.playback.state, 'paused');
    assert.equal(g3.snapshot.playback.updatedBy, 'host');
    assert.equal(g3.snapshot.playback.version, v0 + 1, 'uma ação do usuário = uma versão (sem eco entre abas)');

    // Convidado 2 faz seek para 300 s; Convidado 3 dá play. Qualquer aprovado controla, sem nova aprovação.
    tabs[2].video.seekByUser(300);
    await until(() => tabs.every((t) => Math.abs(t.video.currentTime - 300) < 2.5), 'seek chegou a todos');
    await until(() => g1.snapshot.playback.updatedBy === 'guest2', 'seek registrado por guest2');
    tabs[3].video.playByUser();
    await until(() => tabs.every((t) => !t.video.paused), 'play chegou a todos');
    await until(() => host.snapshot.playback.state === 'playing' && host.snapshot.playback.updatedBy === 'guest3', 'play registrado por guest3');
    await flush(30);
    const versionAfter = host.snapshot.playback.version;
    await flush(30);
    assert.equal(host.snapshot.playback.version, versionAfter, 'a sala está estável (sem laço de eco)');
    assert.ok(versionAfter - v0 <= 4, `versões: ${versionAfter - v0}`);

    // Autoplay bloqueado só em uma aba: ela mostra "Reproduzir aqui"; as outras seguem e nada é pausado na sala.
    tabs[3].video.blockPlay = true;
    tabs[0].video.pauseByUser();
    await until(() => tabs.every((t) => t.video.paused), 'pausa geral antes do teste de bloqueio');
    const vPause = host.snapshot.playback.version;
    tabs[0].video.playByUser();
    await until(() => !tabs[1].video.paused && !tabs[2].video.paused, 'tocando nas abas 1 e 2');
    await until(() => tabs[3].overlay.state.shown, 'aba bloqueada oferece Reproduzir aqui');
    await flush(20);
    assert.equal(tabs[3].video.paused, true);
    assert.equal(host.snapshot.playback.state, 'playing', 'o bloqueio local não pausa os demais');
    assert.equal(host.snapshot.playback.version, vPause + 1);
    tabs[3].video.blockPlay = false;
    await tabs[3].overlay.state.resume();
    await until(() => !tabs[3].video.paused, 'Reproduzir aqui funcionou');
    assert.equal(tabs[3].overlay.state.shown, false);

    // Convidado 1 deixa a aba cair no próximo episódio: só ela se desliga; os outros seguem sincronizados.
    tabs[1].location.href = `${NF}/watch/${Number(WATCH) + 1}`;
    tabs[1].tick();
    await until(() => !b1.bridge.state.bound, 'aba do convidado 1 desassociada');
    assert.match(b1.bridge.state.error || '', /outro título/);
    assert.equal(host.snapshot.media.watchId, WATCH);
    assert.equal(bHost.bridge.state.bound !== null, true);
    tabs[0].video.pauseByUser();
    await until(() => tabs[2].video.paused && tabs[3].video.paused, 'os demais continuam recebendo comandos');
    assert.equal(tabs[1].video.paused, false, 'a aba desligada não é controlada');

    // Credenciais nunca atravessaram portas nem janelas.
    const traffic = wire.join('\n');
    for (const c of clients) assert.ok(!traffic.includes(c.exportSession().token), `${c.role}: credencial vazou`);
    assert.ok(!/Bearer|inviteSecret|hostToken|guestToken/.test(traffic));
    assert.ok(wire.length > 50);
  } finally {
    for (const b of browsers) b.dispose();
    await svc.close();
  }
});

test('dois navegadores/salas no mesmo hub não se misturam; sala errada não controla aba alheia', async () => {
  const svc = createRoomService({ logger: () => {} });
  const addr = await svc.listen(0, '127.0.0.1');
  const env = { url: `http://127.0.0.1:${addr.port}` };
  const made = [];
  try {
    const hubA = createHub({ runtimeId: 'ext-x' });
    const mkPage = (client, tabId) => {
      const win = new FakeWindow(ROOM_ORIGIN);
      const cs = createRoomContent({ window: win, runtime: makeRuntime(hubA, { id: 'ext-x', tabId, origin: ROOM_ORIGIN }), location: win.location, setTimeoutFn: () => 0 });
      const bridge = new NetflixBridge({ window: win, onEvent: () => {}, setIntervalFn: () => 0, clearIntervalFn: () => {} });
      bridge.start(); bridge.setRoom({ code: client.code, you: client.role });
      made.push({ bridge, cs });
      return bridge;
    };
    const a = new DuoRoomClient({ serviceUrl: env.url }); await a.createRoom('Ana');
    const b = new DuoRoomClient({ serviceUrl: env.url }); await b.createRoom('Bia');
    const brA = mkPage(a, 10), brB = mkPage(b, 11);
    const video = new FakeVideo(); const doc = new FakeDocument(video);
    const nc = createNetflixContent({ document: doc, location: { href: `${NF}/watch/${WATCH}` }, runtime: makeRuntime(hubA, { id: 'ext-x', tabId: 20, origin: NF, url: `${NF}/watch/${WATCH}` }), setIntervalFn: () => 1, clearIntervalFn: () => {}, overlayFactory: makeOverlayFactory().factory });
    made.push({ nc });
    await until(() => brA.state.tabs.length === 1 && brB.state.tabs.length === 1, 'ambas as salas veem a aba');
    brA.bind(20, WATCH, 'tmdb:movie:42');
    await until(() => brA.state.bound, 'sala A ligou a aba');
    brB.bind(20, WATCH, 'tmdb:movie:42');
    await until(() => brB.state.error, 'sala B recusada');
    assert.match(brB.state.error, /outra sala/);
    assert.equal(brB.state.bound, null);
    assert.equal(brA.state.tabs[0].mine, true);
    assert.equal(brB.state.tabs[0].mine, false);
  } finally {
    for (const m of made) { m.bridge?.stop(); m.cs?.dispose(); m.nc?.dispose(); }
    await svc.close();
  }
});
