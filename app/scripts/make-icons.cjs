'use strict';
// Gera os ícones do app (Windows .ico, macOS .icns, PNG da janela) a partir de web/assets/duotela-icon.png.
// Roda com o próprio Electron, que sabe redimensionar imagens:  npx electron scripts/make-icons.cjs
// Os arquivos gerados ficam em app/assets e web/assets e são versionados; só rode de novo se a arte mudar.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'web', 'assets', 'duotela-icon.png');
const OUT = path.join(__dirname, '..', 'assets');

function ico(entries) {          // PNG dentro de ICO (aceito pelo Windows Vista em diante)
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...entries.map((e) => e.data)]);
}

function icns(chunks) {          // cada bloco é um PNG; os tipos abaixo aceitam PNG
  const body = Buffer.concat(chunks.map(({ type, data }) => {
    const h = Buffer.alloc(8); h.write(type, 0, 4, 'ascii'); h.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([h, data]);
  }));
  const h = Buffer.alloc(8); h.write('icns', 0, 4, 'ascii'); h.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([h, body]);
}

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(SRC);
  if (img.isEmpty()) { console.error('Arte não encontrada: ' + SRC); app.exit(1); return; }
  const png = (n) => img.resize({ width: n, height: n, quality: 'best' }).toPNG();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.png'), png(512));
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(size) }))));
  fs.writeFileSync(path.join(OUT, 'icon.icns'), icns([['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(([type, n]) => ({ type, data: png(n) }))));
  fs.writeFileSync(path.join(__dirname, '..', '..', 'web', 'assets', 'duotela-icon-64.png'), png(64));   // favicon leve
  console.log('ícones gerados em', OUT);
  app.quit();
});
