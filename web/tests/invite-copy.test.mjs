import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// online-ui.js sai cedo sem DuoTelaAdapter, mas já expõe o helper de cópia.
const window = {};
vm.runInNewContext(readFileSync(new URL('../server/online-ui.js', import.meta.url), 'utf8'), { window, document: { querySelector: () => null } });
const { copyText } = window.DuoInviteCopy;
const SECRET = '123456.segredo-de-teste';

function fakeDoc({ exec, noExec = false } = {}) {
  const log = { created: [], removed: 0, copied: [] };
  const doc = {
    body: { append() {} },
    activeElement: { focus() { log.refocused = true; } },
    createElement() {
      const n = { style: {}, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() { log.removed++; } };
      log.created.push(n); return n;
    },
  };
  if (!noExec) doc.execCommand = (cmd) => { assert.equal(cmd, 'copy'); log.copied.push(log.created[0].value); return exec ? exec(cmd) : true; };
  return { doc, log };
}

test('sem navigator.clipboard (HTTP na LAN): copia via execCommand em campo temporário removido depois', async () => {
  const { doc, log } = fakeDoc();
  assert.equal(await copyText(SECRET, { navigator: {}, document: doc }), 'copied');
  assert.deepEqual(log.copied, [SECRET]);
  assert.equal(log.removed, 1);
  assert.equal(log.refocused, true);
});

test('Clipboard API rejeitada: cai para execCommand', async () => {
  const { doc, log } = fakeDoc();
  const navigator = { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } };
  assert.equal(await copyText(SECRET, { navigator, document: doc }), 'copied');
  assert.deepEqual(log.copied, [SECRET]);
});

test('Clipboard API disponível: usa writeText e não toca no DOM', async () => {
  const { doc, log } = fakeDoc();
  const sent = [];
  assert.equal(await copyText(SECRET, { navigator: { clipboard: { writeText: async (t) => { sent.push(t); } } }, document: doc }), 'copied');
  assert.deepEqual(sent, [SECRET]);
  assert.equal(log.created.length, 0);
});

test('tudo falha (sem execCommand, execCommand falso ou lançando): manual, sem exceção', async () => {
  assert.equal(await copyText(SECRET, { navigator: undefined, document: fakeDoc({ noExec: true }).doc }), 'manual');
  assert.equal(await copyText(SECRET, { navigator: {}, document: fakeDoc({ exec: () => false }).doc }), 'manual');
  const throwing = fakeDoc({ exec: () => { throw new Error(SECRET); } });
  assert.equal(await copyText(SECRET, { navigator: {}, document: throwing.doc }), 'manual');
  assert.equal(throwing.log.removed, 1);
  assert.equal(await copyText(SECRET, { navigator: {}, document: undefined }), 'manual');
});

test('convite vazio ou inválido: "empty", sem tocar em clipboard nem DOM', async () => {
  const { doc, log } = fakeDoc();
  const navigator = { clipboard: { writeText: async () => assert.fail('não deveria copiar') } };
  for (const v of ['', undefined, null, 42]) assert.equal(await copyText(v, { navigator, document: doc }), 'empty');
  assert.equal(log.created.length, 0);
});
