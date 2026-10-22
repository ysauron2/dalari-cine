'use strict';
// Gera o par de chaves das atualizações automáticas (Ed25519). Rode UMA vez.
//   node scripts/update-keys.cjs --write <arquivo-da-chave-privada>
//     grava a chave PÚBLICA em app/update-config.json e a PRIVADA no arquivo indicado (fora do projeto), sem mostrar nada na tela.
//   node scripts/update-keys.cjs
//     só imprime as duas chaves.
// - Chave PÚBLICA: vai em app/update-config.json e no código; qualquer pessoa pode vê-la.
// - Chave PRIVADA: vai só no segredo UPDATE_SIGNING_KEY do GitHub, com uma cópia de segurança sua (gerenciador de senhas).
//   Quem tiver a chave privada publica atualizações que todos os apps aceitam. Se perdê-la, os apps já instalados não aceitam
//   mais atualizações assinadas por outra chave (a pessoa precisaria reinstalar à mão).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

const at = process.argv.indexOf('--write');
if (at === -1) {
  console.log('CHAVE PÚBLICA (update-config.json, campo publicKey):');
  console.log(pub);
  console.log('\nCHAVE PRIVADA (segredo UPDATE_SIGNING_KEY no GitHub; não salve em arquivo do projeto, não envie a ninguém):');
  console.log(priv);
} else {
  const target = process.argv[at + 1];
  if (!target) { console.error('Uso: node scripts/update-keys.cjs --write <arquivo-da-chave-privada>'); process.exit(2); }
  const keyFile = path.resolve(target);
  const cfgFile = path.join(__dirname, '..', 'update-config.json');
  const projectRoot = path.resolve(__dirname, '..', '..');
  if (keyFile.startsWith(projectRoot + path.sep)) { console.error('Guarde a chave privada FORA da pasta do projeto.'); process.exit(2); }
  if (fs.existsSync(keyFile)) { console.error('Já existe um arquivo em ' + keyFile + ': não sobrescrevo uma chave. Escolha outro nome.'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  if (cfg.publicKey) { console.error('update-config.json já tem uma chave pública. Trocá-la impede que apps já instalados se atualizem; apague o campo à mão se for isso mesmo que você quer.'); process.exit(2); }
  fs.writeFileSync(keyFile, priv + '\n', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, publicKey: pub }, null, 2) + '\n');
  console.log('Chave pública gravada em app/update-config.json.');
  console.log('Chave privada gravada em: ' + keyFile);
  console.log('Próximo passo: cadastrar no GitHub como segredo UPDATE_SIGNING_KEY e guardar uma cópia segura.');
}
