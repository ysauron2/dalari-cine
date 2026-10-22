'use strict';
// Carimba, na cópia empacotada do app (resources/app), a versão da tag e o repositório das atualizações.
//   VERSION=1.2.3 GITHUB_REPOSITORY=dono/repo node scripts/stamp-build.cjs <resources/app>
// Sem VERSION fica a versão do package.json (0.1.0 de desenvolvimento) e a pasta não é alterada.
const fs = require('node:fs');
const path = require('node:path');

function stamp(dir, { version, repo }) {
  const pkgPath = path.join(dir, 'package.json');
  if (version) {
    // Versões que não são x.y.z (ex.: 0.0.0-dev em build sem tag) ficam assim mesmo: o app as trata como "desenvolvimento" e não se atualiza.
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  const cfgPath = path.join(dir, 'update-config.json');
  if (repo && fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!cfg.repo) cfg.repo = repo;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  }
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('Uso: stamp-build.cjs <resources/app>'); process.exit(2); }
  stamp(dir, { version: process.env.VERSION, repo: process.env.GITHUB_REPOSITORY });
}
module.exports = { stamp };
