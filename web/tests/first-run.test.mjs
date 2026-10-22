import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { privacyMarkdown } from '../tools/gen-privacy-md.mjs';
const require = createRequire(import.meta.url);
const { WELCOME, POLICY, FLAG_KEY } = require('../server/first-run.js');

test('PRIVACIDADE.md está em dia com o texto da política mostrado no aplicativo', () => {
  const file = readFileSync(new URL('../../PRIVACIDADE.md', import.meta.url), 'utf8');
  assert.equal(file, privacyMarkdown(), 'rode: node web/tools/gen-privacy-md.mjs');
});

test('boas-vindas dizem que não há cadastro/login e que nada de estatística é enviado; a política cita os serviços de terceiros', () => {
  const welcome = WELCOME.map(([h, p]) => `${h} ${p}`).join(' ');
  assert.match(welcome, /não tem cadastro nem login/);
  assert.match(welcome, /apenas neste computador/);
  assert.match(welcome, /não envia estatísticas de uso/);
  const policy = POLICY.map(([h, p]) => `${h} ${p}`).join(' ');
  for (const t of ['ntfy.sh', 'STUN', 'TMDB', 'Netflix', 'YouTube', 'não coletamos', 'Como apagar']) assert.match(policy, new RegExp(t, 'i'), t);
  assert.match(FLAG_KEY, /^duotela-welcome-v\d+$/);
});

test('Sobre e créditos: homenagem, autoria, aviso de terceiros e links só do GitHub', () => {
  const { ABOUT, LINKS } = require('../server/first-run.js');
  const text = ABOUT.map(([h, p]) => `${h} ${p}`).join(' ');
  assert.match(text, /Larissa B\./);
  assert.doesNotMatch(text, /Batista|Sousa/, 'sem o sobrenome da Larissa');
  assert.match(text, /Daniel Didini \(Kaizen\)/);
  assert.match(text, /Kaizen/);
  assert.match(text, /not endorsed or certified by TMDB/);
  assert.match(text, /não é afiliado/);
  for (const url of Object.values(LINKS)) assert.match(url, /^https:\/\/github\.com\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/);
});

test('homenagem em 3D: texto certo, sem sobrenome, e só aparece uma vez', () => {
  const T = require('../server/tribute.js');
  const text = [T.TEXT.title, T.TEXT.names.join(' '), T.TEXT.line, T.TEXT.by].join(' ');
  assert.match(text, /Larissa B\./);
  assert.match(text, /Daniel Didini \(Kaizen\)/);
  assert.doesNotMatch(text, /Batista|Sousa/);
  const store = new Map();
  const win = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  assert.equal(T.hasSeen(win), false);
  T.markSeen(win);
  assert.equal(T.hasSeen(win), true);
  assert.equal(T.show({ win }), false, 'já vista: não mostra de novo');
  assert.equal(T.hasSeen({ get localStorage() { throw new Error('bloqueado'); } }), false, 'sem armazenamento: não quebra');
});

test('a homenagem abre com um clique em Sobre e créditos e nunca aparece sozinha', () => {
  const src = readFileSync(new URL('../server/first-run.js', import.meta.url), 'utf8');
  assert.match(src, /Ver a homenagem/, 'botão visível no Sobre');
  assert.doesNotMatch(src, /DuoTribute\?\.show\(\{ onClose/, 'nada de homenagem automática na abertura');
  assert.equal((src.match(/DuoTribute\?\.show\(/g) || []).length, 1, 'só o botão chama a homenagem');
});

test('homenagem 3D: com "reduzir movimento" a cena aparece parada, mas há um botão para ver a animação mesmo assim', () => {
  const src = readFileSync(new URL('../server/tribute.js', import.meta.url), 'utf8');
  assert.match(src, /:where\(:root\[data-motion="reduced"\],:root\[data-motion="off"\]\) \.duo-tribute:not\(\.tb-motion\) \*\{animation:none!important/,'a regra de movimento reduzido não vale depois que a pessoa pede a animação');
  assert.match(src, /Ver a animação/);
  assert.match(src, /motion: true/);
});
