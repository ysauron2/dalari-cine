import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const C = require('../server/chat.js');
const { createRoomService } = require('../server/room-service.js');
const { DuoRoomClient, RoomError } = require('../server/client.js');

// ---------- DOM mínimo, só o que o painel usa ----------
class FakeEl {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.value = ''; this.disabled = false; this.scrollTop = 0; this.scrollHeight = 100; this._text = ''; this.classes = new Set(); this.focused = 0; this.removed = false;
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => (c.textContent !== undefined ? c.textContent : c.text)).join(''); }
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; this._text = ''; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  async fire(type, ev = {}) { for (const fn of this.listeners[type] || []) await fn({ preventDefault() {}, stopPropagation() { ev.stopped = true; }, ...ev }); }
  focus() { this.focused++; }
  remove() { this.removed = true; }
  find(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) if (c instanceof FakeEl) c.find(pred, out); return out; }
}
function fakeDoc() {
  const timers = [];
  const doc = { head: new FakeEl('head'), body: new FakeEl('body'), createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }), defaultView: {} };
  doc.defaultView.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  doc.defaultView.clearTimeout = () => {};
  return { doc, timers };
}
const names = { host: 'Daniel', guest: 'Larissa' };
const msg = (id, slot, text) => ({ id, slot, text, at: 0 });
function dock({ send = async () => {} } = {}) {
  const { doc, timers } = fakeDoc();
  const d = C.createDock({ doc, send, nameFor: (r) => names[r] || r });
  const q = (cls) => d.el.find((n) => n.classes.has(cls) || n.attrs.class === cls)[0];
  return { d, timers, doc, bubble: q('chat-bubble'), badge: q('chat-badge'), toggle: q('chat-toggle'), panel: q('chat-panel'), form: q('chat-form'), input: d.el.find((n) => n.tag === 'input')[0], err: q('chat-err'), list: q('chat-list') };
}

test('texto: uma linha só, sem caracteres de controle, espaços juntos e no máximo 300', () => {
  assert.equal(C.cleanText('  oi   tudo\tbem?\n\nvamos  '), 'oi tudo bem? vamos');
  assert.equal(C.cleanText(''), ''); assert.equal(C.cleanText(null), ''); assert.equal(C.cleanText(undefined), '');
  assert.equal(C.cleanText('a' + String.fromCharCode(0) + 'b' + String.fromCharCode(127) + 'c'), 'a b c');
  assert.equal(C.cleanText('x'.repeat(500)).length, C.MAX_TEXT);
  assert.equal(C.cleanText('<b>oi</b>'), '<b>oi</b>', 'o texto não é alterado: a tela usa textContent');
});

test('não vistas, último id e texto do aviso', () => {
  const list = [msg(1, 'host', 'a'), msg(2, 'guest', 'b'), msg(3, 'guest', 'c')];
  assert.deepEqual(C.unreadFrom(list, 1, 'host').map((m) => m.id), [2, 3]);
  assert.deepEqual(C.unreadFrom(list, 0, 'guest').map((m) => m.id), [1], 'as minhas não contam');
  assert.deepEqual(C.unreadFrom(undefined, 0, 'host'), []);
  assert.equal(C.lastId(list), 3); assert.equal(C.lastId([]), 0); assert.equal(C.lastId(null), 0);
  assert.equal(C.bubbleText('Larissa', 'já vai começar?'), 'Larissa: já vai começar?');
  const long = C.bubbleText('Larissa', 'x'.repeat(300));
  assert.equal(long.length, 110); assert.ok(long.endsWith('…'));
});

test('painel: histórico antigo não vira aviso; mensagem nova mostra aviso discreto e some sozinha', () => {
  const t = dock();
  assert.equal(t.d.el.hidden, true, 'fora de uma sala o chat não aparece');
  t.d.update({ active: true, you: 'host', messages: [msg(1, 'guest', 'antiga')] });
  assert.equal(t.d.el.hidden, false);
  assert.equal(t.bubble.hidden, true, 'o que já estava na sala não gera aviso');
  assert.equal(t.badge.hidden, true);
  t.d.update({ active: true, you: 'host', messages: [msg(1, 'guest', 'antiga'), msg(2, 'host', 'minha')] });
  assert.equal(t.bubble.hidden, true, 'a minha mensagem não avisa a mim mesmo');
  t.d.update({ active: true, you: 'host', messages: [msg(1, 'guest', 'antiga'), msg(2, 'host', 'minha'), msg(3, 'guest', 'já vai começar?')] });
  assert.equal(t.bubble.hidden, false);
  assert.equal(t.bubble.textContent, 'Larissa: já vai começar?');
  assert.equal(t.badge.hidden, false); assert.equal(t.badge.textContent, '1', 'só a nova conta: a antiga já estava na sala quando o chat apareceu');
  assert.match(t.toggle.attrs['aria-label'], /1 mensagem nova/);
  assert.equal(t.timers.length, 1);
  t.timers[0]();
  assert.equal(t.bubble.hidden, true, 'o aviso some sozinho');
  assert.equal(t.badge.hidden, false, 'o contador fica até abrir o chat');
  t.d.update({ active: true, you: 'host', messages: [msg(1, 'guest', 'antiga'), msg(2, 'host', 'minha'), msg(3, 'guest', 'já vai começar?')] });
  assert.equal(t.bubble.hidden, true, 'a mesma mensagem não avisa duas vezes');
});

test('painel: abrir marca como lido, mostra as mensagens com nome e fecha com Esc devolvendo o foco', async () => {
  const t = dock();
  t.d.update({ active: true, you: 'host', messages: [] });
  t.d.update({ active: true, you: 'host', messages: [msg(1, 'guest', 'oi <b>tudo</b>?'), msg(2, 'host', 'oi!')] });
  assert.equal(t.badge.textContent, '1');
  await t.toggle.fire('click');
  assert.equal(t.d.isOpen(), true); assert.equal(t.panel.hidden, false);
  assert.equal(t.toggle.attrs['aria-expanded'], 'true');
  assert.equal(t.badge.hidden, true); assert.equal(t.bubble.hidden, true);
  assert.equal(t.input.focused > 0, true, 'o foco vai para o campo só porque a pessoa abriu');
  const lines = t.list.children.map((li) => li.textContent);
  assert.deepEqual(lines, ['Larissaoi <b>tudo</b>?', 'Vocêoi!'], 'o texto entra como texto, nunca como HTML');
  const ev = {}; await t.panel.fire('keydown', { key: 'Escape', ...ev });
  assert.equal(t.d.isOpen(), false); assert.equal(t.panel.hidden, true); assert.equal(t.toggle.focused > 0, true);
  // com o painel aberto, mensagens novas são lidas na hora e não geram aviso
  await t.toggle.fire('click');
  t.d.update({ active: true, you: 'host', messages: [msg(1, 'guest', 'a'), msg(2, 'host', 'b'), msg(3, 'guest', 'c')] });
  assert.equal(t.bubble.hidden, true); assert.equal(t.badge.hidden, true);
  assert.equal(t.list.children.length, 3);
});

test('painel: ao sair da sala o chat some e a próxima sala começa limpa', () => {
  const t = dock();
  t.d.update({ active: true, you: 'host', messages: [msg(5, 'guest', 'x')] });
  t.d.update({ active: true, you: 'host', messages: [msg(5, 'guest', 'x'), msg(6, 'guest', 'y')] });
  assert.equal(t.bubble.hidden, false);
  t.d.update({ active: false });
  assert.equal(t.d.el.hidden, true); assert.equal(t.bubble.hidden, true); assert.equal(t.d.isOpen(), false);
  t.d.update({ active: true, you: 'host', messages: [msg(1, 'guest', 'sala nova, mensagem velha')] });
  assert.equal(t.bubble.hidden, true, 'não repete avisos da sala anterior');
  t.d.update({ active: false }); t.d.update({ active: false });     // repetir é inofensivo
});

test('painel: enviar limpa o campo; erro mantém o texto e explica; vazio não envia', async () => {
  const sent = [];
  let fail = null;
  const t = dock({ send: async (text) => { if (fail) throw fail; sent.push(text); } });
  t.d.update({ active: true, you: 'host', messages: [] });
  await t.toggle.fire('click');
  t.input.value = '   '; await t.form.fire('submit');
  assert.deepEqual(sent, [], 'só espaços não envia');
  t.input.value = '  oi   Larissa\n ';
  await t.form.fire('submit');
  assert.deepEqual(sent, ['oi Larissa']); assert.equal(t.input.value, ''); assert.equal(t.err.hidden, true);
  fail = Object.assign(new Error('x'), { code: 'rate_limited' });
  t.input.value = 'de novo'; await t.form.fire('submit');
  assert.equal(t.input.value, 'de novo', 'o texto não se perde'); assert.equal(t.err.hidden, false); assert.match(t.err.textContent, /uma mensagem por vez/);
  fail = new Error('rede');
  await t.form.fire('submit');
  assert.match(t.err.textContent, /Tente de novo/);
  assert.equal(t.form.find((n) => n.tag === 'button')[0].disabled, false, 'o botão volta a funcionar');
});

// ---------- sala ----------
async function boot() {
  const clock = { t: 1_000_000 };
  const svc = createRoomService({ now: () => clock.t });
  const addr = await svc.listen(0, '127.0.0.1');
  return { clock, url: `http://127.0.0.1:${addr.port}`, stop: () => svc.close() };
}
const rejects = (p, code, status) => assert.rejects(p, (e) => e instanceof RoomError && e.code === code && (status === undefined || e.status === status));

test('sala: todos veem as mensagens na ordem, com quem enviou; só as últimas 30 ficam; intervalo mínimo por pessoa', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url }), guest = new DuoRoomClient({ serviceUrl: env.url });
    const created = await host.createRoom(); await guest.joinRoom(created.invite); await host.approveGuest();
    assert.deepEqual((await host.getState({ after: 0 })).chat, []);
    await host.sendChat('Oi!');
    await rejects(host.sendChat('de novo'), 'rate_limited', 429);
    await guest.sendChat('Oi, já vai começar?');
    const s = await host.getState({ after: 0 });
    assert.deepEqual(s.chat.map((m) => [m.id, m.slot, m.text]), [[1, 'host', 'Oi!'], [2, 'guest', 'Oi, já vai começar?']]);
    assert.equal((await guest.getState({ after: 0 })).chat.length, 2);
    for (let i = 0; i < 34; i++) { env.clock.t += 800; await host.sendChat('mensagem ' + i); }
    const full = await guest.getState({ after: 0 });
    assert.equal(full.chat.length, 30);
    assert.equal(full.chat.at(-1).text, 'mensagem 33'); assert.equal(full.chat[0].id, full.chat.at(-1).id - 29);
  } finally { await env.stop(); }
});

test('sala: texto inválido é recusado (vazio, longo, quebra de linha, espaços nas pontas, campo extra, tipo errado)', async () => {
  const env = await boot();
  try {
    const host = new DuoRoomClient({ serviceUrl: env.url }), guest = new DuoRoomClient({ serviceUrl: env.url });
    const created = await host.createRoom(); await guest.joinRoom(created.invite); await host.approveGuest();
    for (const text of ['', ' oi', 'oi ', 'a\nb', 'a' + String.fromCharCode(0) + 'b', 'x'.repeat(301), 5, null]) {
      await rejects(host.send('chat.send', { text }), 'bad_payload', 400);
    }
    await rejects(host.send('chat.send', { text: 'oi', extra: 1 }), 'bad_payload', 400);
    await rejects(host.send('chat.send', {}), 'bad_payload', 400);
    await host.sendChat('x'.repeat(300));
    assert.equal((await host.getState({ after: 0 })).chat.find((m) => m.text.length === 300)?.text.length, 300, 'no limite é aceito');
  } finally { await env.stop(); }
});

test('a página carrega o chat, o serviço o entrega e a tela o liga à sala', () => {
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /<script src="server\/chat\.js"><\/script>/);
  assert.match(readFileSync(new URL('../server/room-service.js', import.meta.url), 'utf8'), /'\/server\/chat\.js', 'server\/chat\.js'/);
  const ui = readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /window\.DuoChat\?\.createDock\(\{ doc: document, send: \(text\) => client\.sendChat\(text\)/);
  assert.match(ui, /chatDock\?\.update\(\{ active: true, you: client\.role, messages: s\.chat \|\| \[\] \}\)/);
  assert.match(ui, /chatDock\?\.update\(\{ active: false \}\)/);
});
