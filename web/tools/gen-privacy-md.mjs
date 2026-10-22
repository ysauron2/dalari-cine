// Gera PRIVACIDADE.md (raiz do repositório) a partir do texto da política em web/server/first-run.js.
//   node web/tools/gen-privacy-md.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { POLICY } = require('../server/first-run.js');

export const privacyMarkdown = () => '# Política de privacidade do Dalari Cine\n\n'
  + 'Esta é a mesma política mostrada dentro do aplicativo (Perfil → Política de privacidade). Gerada por `web/tools/gen-privacy-md.mjs`; edite o texto em `web/server/first-run.js`.\n\n'
  + POLICY.map(([h, p]) => `## ${h}\n\n${p}\n`).join('\n');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL('../../PRIVACIDADE.md', import.meta.url), privacyMarkdown());
  console.log('PRIVACIDADE.md atualizado');
}
