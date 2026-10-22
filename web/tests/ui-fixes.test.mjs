import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('reações continuam visíveis com "reduzir movimento": a regra global que zera animações não apaga a reação', () => {
  const ui = read('../server/online-ui.js');
  assert.ok(ui.includes('.reaction-fly{animation:react-fade 2s linear forwards!important;animation-duration:2s!important}'));
  const css = read('../styles/motion.css');
  assert.ok(css.includes('animation-duration: .01ms !important;'), 'a regra geral de movimento reduzido existe (styles/motion.css), por isso a exceção precisa de !important');
});

test('botão "Sugestão ou problema" na lateral estreita vira só o ícone, sem texto quebrado, e continua acessível', () => {
  const html = read('../index.html');
  assert.ok(html.includes('class="side-feedback" data-duo-open="feedback" title="Sugestão ou problema" aria-label="Sugestão ou problema"'));
  assert.ok(html.includes('<span class="sf-label"> Sugestão ou problema</span>'));
  assert.ok(html.includes('@media(max-width:1200px){.sidebar .side-feedback{width:44px;height:44px;padding:0;') && html.includes('.sidebar .side-feedback .sf-label{display:none}'));
});

test('chat fácil de achar: botão com a palavra "Chat" no canto e "Abrir chat" dentro do cartão da sala', () => {
  const chat = read('../server/chat.js');
  assert.ok(chat.includes("'\\u{1F4AC} Chat'"));
  assert.ok(chat.includes('.chat-toggle{position:relative;min-width:44px;height:44px;padding:0 16px;border-radius:22px;'));
  const ui = read('../server/online-ui.js');
  assert.ok(ui.includes("'chat-open'") && ui.includes("if (act === 'chat-open') return void chatDock?.open();"));
});

test('modo cinema avisa quando ele age: só ao dar play', () => {
  const ui = read('../server/online-ui.js');
  assert.ok(ui.includes("'@moon Modo cinema: ligado (age ao dar play)'"));
});
