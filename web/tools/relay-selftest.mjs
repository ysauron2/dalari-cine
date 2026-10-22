// Teste de ponta a ponta do código curto contra um relé REAL (padrão: https://ntfy.sh). Rode você mesmo:
//   node tools/relay-selftest.mjs [https://ntfy.sh]
// Simula Host e convidado neste processo, com um código aleatório. Envia ao relé apenas mensagens cifradas,
// em tópicos derivados desse código, que ninguém mais conhece. Não usa nenhuma credencial.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../server/p2p-rendezvous.js');

const base = process.argv[2] || R.DEFAULT_RELAY;
const relay = new R.Relay({ baseUrl: base });
const code = R.newCode();
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

console.log(`Relé: ${base}\n`);
try {
  const host = R.hostListen({ code, relay, respond: async (offer) => { step('Host recebeu e decifrou a oferta'); return { answer: 'DT2.RESPOSTA-DE-TESTE', extra: { room: '123456' } }; } });
  await new Promise((r) => setTimeout(r, 1500));
  step('Host escutando; convidado publicando a oferta…');
  const out = await R.guestPair({ code, relay, offer: 'DT2.OFERTA-DE-TESTE', timeoutMs: 30000 });
  step('Convidado recebeu e decifrou a resposta');
  await host.result;
  if (out.answer !== 'DT2.RESPOSTA-DE-TESTE' || out.extra?.room !== '123456') throw new Error('Conteúdo inesperado: ' + JSON.stringify(out));
  console.log('\nOK: publicar, escutar em tempo real, cifrar e decifrar funcionam com este relé.');

  step('Teste de uso único: segundo convidado com o mesmo código…');
  try { await R.guestPair({ code, relay, offer: 'DT2.SEGUNDO', timeoutMs: 6000 }); console.log('FALHA: um segundo convidado conseguiu parear com o mesmo código.'); process.exitCode = 1; }
  catch { console.log('OK: o segundo convidado não pareou (uso único).'); }
} catch (e) {
  console.log('\nFALHOU:', e.message);
  console.log('Se for erro de rede ou 4xx/5xx, o relé está indisponível, bloqueado ou limitando o uso; nesse caso use a conexão manual (códigos grandes).');
  process.exitCode = 1;
}
process.exit();
