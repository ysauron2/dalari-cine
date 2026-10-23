// Conexão direta de verdade (P2PLink) entre duas pontas no mesmo computador, com e sem o retransmissor na lista de servidores,
// passando pelo código compacto (DT2). Mostra os candidatos que entram no código e se o canal abre.
// Uso: node tools/e2e-p2p-turn.mjs [endereco-do-worker]
import { readFile } from 'node:fs/promises';
import { launch } from './cdp.mjs';

const WORKER = (process.argv[2] || 'https://dalari-stats.dalaricine.workers.dev').replace(/\/+$/, '');
const ice = await (await fetch(WORKER + '/v1/ice')).json();
if (!ice.ok) { console.log('Worker sem TURN:', JSON.stringify(ice)); process.exit(1); }
const stun = [{ urls: 'stun:stun.l.google.com:19302' }];
const src = await readFile(new URL('../server/p2p-link.js', import.meta.url), 'utf8');

const chrome = await launch();
let ok = true;
try {
  const p = await chrome.browser.page();
  await p.goto('about:blank');
  await p.evaluate(src);
  for (const [name, servers, relayOnly] of [['só STUN', stun, false], ['STUN + TURN', ice.iceServers.concat(stun), false], ['SÓ RELAY', ice.iceServers, true]]) {
    const out = await p.evaluate(async (servers, relayOnly) => {
      const { P2PLink, decodeCode } = window.DuoP2P;
      const RTC = relayOnly ? class extends RTCPeerConnection { constructor(c) { super({ ...c, iceTransportPolicy: 'relay' }); } } : undefined;
      const host = new P2PLink({ iceServers: servers, RTC }), guest = new P2PLink({ iceServers: servers, RTC });
      const t0 = performance.now();
      const offer = await host.createOffer({ room: '123456' });
      const tOffer = Math.round(performance.now() - t0);
      const { answer } = await guest.acceptOffer(offer, { room: '123456' });
      await host.acceptAnswer(answer);
      const result = await Promise.race([host.opened.then(() => 'open', () => 'failed'), new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
      const types = (code) => [...decodeCode(code).sdp.matchAll(/typ (\w+)/g)].map((m) => m[1]).join(',');
      const o = { result, tOffer, offerLen: offer.length, offerTypes: types(offer), answerTypes: types(answer) };
      host.close(); guest.close();
      return o;
    }, servers, relayOnly);
    console.log(name.padEnd(12), JSON.stringify(out));
    if (out.result !== 'open') ok = false;
  }
} finally { await chrome.close(); }
console.log(ok ? 'OK' : 'FALHA');
process.exit(ok ? 0 : 1);
