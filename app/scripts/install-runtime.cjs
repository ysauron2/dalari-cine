'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const installer = path.join(root, 'node_modules', 'electron', 'install.js');
const result = spawnSync(process.execPath, [installer], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, electron_config_cache: path.join(root, '.electron-cache') }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
