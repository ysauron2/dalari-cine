'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { app, components, BaseWindow, WebContentsView, dialog, session, ipcMain, Menu, utilityProcess, net, shell } = require('electron');
const { createUpdater } = require('./src/updater.cjs');
const { isAllowedExternal } = require('./src/external-links.cjs');
const settingsStore = require('./src/settings-store.cjs');
const { NETFLIX_URL, netflixNavigationAllowed, netflixSearchUrl, parseJoinUrl, findJoinCode, parseDuoTelaUrl, sameDuoTelaOrigin, insecureOriginToTreatAsSecure } = require('./src/url-policy.cjs');
const { workspaceBounds } = require('./src/layout.cjs');
const { resolveProfileDir, readDuoTelaUrlSetting, readAllowLanSetting, readAllowRemoteSetting, migrateLegacyProfile } = require('./src/runtime-paths.cjs');

let window;
let duoView;
let netflixView;
let toolbarView;
let panelOpen = false;
let roomPlatform = null;
let netflixLoaded = false;
let netflixRoomState = null;
let bundledServer = null;
let pendingNetflixSearch = null;   // busca pedida antes de a sala estar em modo Netflix: abre assim que a janela da Netflix aparecer
let pttCode = null;   // tecla de push-to-talk escolhida na interface (KeyboardEvent.code)

// Uma instância só: um link dalari://entrar/XXXX-XXXX clicado com o app aberto vai para a janela que já existe
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) app.quit();
// Convite com um toque: o código fica pendente até a interface avisar que está pronta (duotela:join-ready); só então é entregue
let pendingJoin = findJoinCode(process.argv);
let joinReady = false;
const flushJoin = () => {
  if (pendingJoin && joinReady && duoView && !duoView.webContents.isDestroyed()) {
    duoView.webContents.send('duotela:join-link', pendingJoin);
    pendingJoin = null;
  }
};
const focusWindow = () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
};
const handleJoinCode = code => {
  if (!code) return;
  pendingJoin = code;
  focusWindow();
  flushJoin();
};
app.on('second-instance', (_event, argv) => {
  const code = findJoinCode(argv);
  if (code) handleJoinCode(code);
  else focusWindow();
});
app.on('open-url', (event, url) => {   // macOS entrega o link por aqui (também antes de o app ficar pronto)
  event.preventDefault();
  handleJoinCode(parseJoinUrl(url));
});
// Registra o dalari:// neste usuário (o instalador do Windows e o Info.plist do Mac também declaram). Só no app instalado, para não sequestrar o link no desenvolvimento.
if (app.isPackaged) app.setAsDefaultProtocolClient('dalari');

const profileDir = resolveProfileDir({ env: process.env, bundleDir: __dirname, appDataDir: app.getPath('appData'), packaged: app.isPackaged, devDir: path.join(__dirname, '.runtime-profile') });
migrateLegacyProfile({ appDataDir: app.getPath('appData'), profileDir, fs });   // preserva os dados de quem usou o nome antigo
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);

// Servidor Dalari Cine fora do loopback é opt-in: DUOTELA_ALLOW_LAN=1 (HTTP em IPv4 privado) ou DUOTELA_ALLOW_REMOTE=1 (HTTPS
// na internet). O padrão continua sendo só loopback.
// A opção do Chromium precisa existir antes de o app ficar pronto, então a URL é lida e validada aqui.
const settingArgs = { env: process.env, profileDir, readFile: fs.readFileSync };
const allowLan = readAllowLanSetting(settingArgs);
const allowRemote = readAllowRemoteSetting(settingArgs);
let configuredDuoUrl = null;
let configuredDuoUrlError = null;
try {
  const configured = readDuoTelaUrlSetting({ env: process.env, profileDir, readFile: fs.readFileSync });
  configuredDuoUrl = configured ? parseDuoTelaUrl(configured, { allowLan, allowRemote }) : null;
} catch (error) {
  configuredDuoUrlError = error;
}
// Conexão direta: por padrão o Chromium troca o IP da rede local por um nome mDNS (xxxx.local) nos candidatos WebRTC.
// Dois PCs na mesma casa nem sempre resolvem esse nome (firewall, roteador) e a rota pelo IP público (hairpin) costuma falhar.
// Expor o IP local ao parceiro, que já é de confiança por ter o convite, torna a conexão na mesma rede confiável.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
const lanOrigin = insecureOriginToTreatAsSecure(configuredDuoUrl);
if (lanOrigin) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', lanOrigin);

function startBundledServer(port = 0) {
  const entry = path.join(__dirname, 'preview', 'server', 'index.js');
  if (!fs.existsSync(entry)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(entry, [], {
      cwd: path.dirname(entry),
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ALLOW_NON_LOOPBACK: '0', TMDB_READ_ACCESS_TOKEN: '', YOUTUBE_DATA_API_KEY: '' },
      stdio: 'pipe',
      serviceName: 'Dalari Cine sala local'
    });
    bundledServer = child;
    let settled = false;
    let output = '';
    let errors = '';
    // A primeira abertura pode demorar (antivírus verificando os arquivos recém-baixados).
    const timer = setTimeout(() => finish(new Error(`O serviço local não iniciou a tempo.${detail()}`)), 60000);
    const detail = () => (errors.trim() ? `\n\nDetalhe técnico:\n${errors.trim().slice(-400)}` : '');
    function finish(error, url) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
      else resolve(url);
    }
    child.stdout?.on('data', chunk => {
      output = (output + chunk.toString('utf8')).slice(-4096);
      const match = /Interface de teste: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
      if (match) finish(null, match[1]);
    });
    child.stderr?.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-1024); diagnostic('local_service_error'); });
    child.on('exit', code => finish(new Error(`O serviço local encerrou antes da interface (código ${code}).${detail()}`)));
  });
}

// ---- atualização automática (veja src/updater.cjs) ----
let updater = null;
const updateStore = {                       // só a preferência "verificar sozinho", guardada no perfil
  file: path.join(profileDir, 'updates.json'),
  read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { return {}; } },
  get(key) { return this.read()[key]; },
  set(key, value) { try { fs.writeFileSync(this.file, JSON.stringify({ ...this.read(), [key]: value })); } catch { /* sem permissão: segue com o padrão */ } }
};
function readUpdateConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'update-config.json'), 'utf8')); } catch { return null; }
}
function launchInstaller(file) {
  // Windows: instalador silencioso (por usuário, sem pedir administrador); ele espera o app fechar e abre o novo.
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve({ quit: true }); });
    });
  }
  // macOS: só abre o .dmg; arrastar para Aplicativos é com a pessoa (o app não é assinado pela Apple).
  return shell.openPath(file).then(problem => { if (problem) throw new Error(problem); return { quit: false }; });
}
function sendUpdateState(state) {
  if (duoView && !duoView.webContents.isDestroyed()) duoView.webContents.send('duotela:update-state', state);
}

// O localStorage da interface é por endereço (inclui a porta). Por isso a porta do serviço local é sempre a mesma: a última
// que funcionou fica em <perfil>/local-port.txt. Se estiver ocupada, usa outra só nesta abertura (as configurações voltam da
// cópia de segurança, veja settings-store.cjs) e continua tentando a mesma nas próximas.
async function startStableServer() {
  const dir = profileDir, saved = settingsStore.readPort({ fs, dir });
  if (saved) {
    try { return await startBundledServer(saved); }
    catch (error) {
      diagnostic('local_port_unavailable', { port: saved });
      if (bundledServer) { try { bundledServer.kill(); } catch { /* já encerrado */ } bundledServer = null; }
    }
  }
  const url = await startBundledServer(0);
  if (!saved && url) { const port = Number(new URL(url).port); settingsStore.writePort({ fs, dir, port }); }
  return url;
}

function hostOnly(raw) {
  try { return new URL(raw).hostname; } catch { return 'inválido'; }
}

function diagnostic(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

function restrictNavigation(contents, accepts, label) {
  const check = (event, details) => {
    const raw = typeof details === 'string' ? details : details?.url;
    if (accepts(raw)) return;
    event.preventDefault();
    diagnostic('navigation_blocked', { view: label, host: hostOnly(raw) });
  };
  contents.on('will-frame-navigate', (event, details) => {
    if (details.isMainFrame) check(event, details);
  });
  contents.on('will-redirect', (event, details) => {
    if (details.frame && details.frame === contents.mainFrame) check(event, details);
  });
  contents.setWindowOpenHandler(({ url }) => {
    diagnostic('new_window_blocked', { view: label, host: hostOnly(url) });
    return { action: 'deny' };
  });
  contents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) diagnostic('load_failed', { view: label, code: errorCode, host: hostOnly(validatedURL) });
  });
  contents.on('did-finish-load', () => {
    diagnostic('page_loaded', { view: label, host: hostOnly(contents.getURL()) });
  });
  contents.on('render-process-gone', (_event, details) => diagnostic('renderer_gone', { view: label, reason: details.reason }));
}

function makeView(partition, preload) {
  return new WebContentsView({
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      ...(preload ? { preload } : {})
    }
  });
}

function resizeViews() {
  if (!window || !duoView || !netflixView || !toolbarView) return;
  const { width, height } = window.getContentBounds();
  if (width <= 0 || height <= 0) return;
  const bounds = workspaceBounds(width, height, roomPlatform, panelOpen);
  netflixView.setBounds(bounds.netflix);
  duoView.setBounds(bounds.duotela);
  if (bounds.toggle) toolbarView.setBounds(bounds.toggle);
}

function setPanel(open) {
  if (!window || !toolbarView || roomPlatform !== 'netflix') return;
  panelOpen = Boolean(open);
  resizeViews();
  if (!toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send('duotela:panel-state', panelOpen);
  }
  diagnostic('panel_state', { open: panelOpen });
}

function setRoomPlatform(platform) {
  if (!window || !duoView || !netflixView || roomPlatform === platform) return;
  const wasNetflix = roomPlatform === 'netflix';
  roomPlatform = platform;
  if (platform !== 'netflix') netflixRoomState = null;
  if (platform === 'netflix') {
    panelOpen = true;
    window.contentView.addChildView(netflixView);
    window.contentView.removeChildView(duoView);
    window.contentView.addChildView(duoView);
    window.contentView.addChildView(toolbarView);
    netflixView.webContents.setAudioMuted(false);
    if (pendingNetflixSearch) {
      const search = pendingNetflixSearch;
      pendingNetflixSearch = null;
      netflixLoaded = true;
      netflixView.webContents.loadURL(search).catch(() => {});
    } else if (!netflixLoaded) {
      netflixLoaded = true;
      netflixView.webContents.loadURL(NETFLIX_URL).catch(() => {});
    }
  } else {
    panelOpen = false;
    pendingNetflixSearch = null;
    if (wasNetflix) {
      netflixView.webContents.setAudioMuted(true);
      const current = netflixView.webContents.getURL();
      if (netflixNavigationAllowed(current) && new URL(current).pathname.startsWith('/watch/')) {
        netflixView.webContents.loadURL(NETFLIX_URL).catch(() => {});
      }
    }
    window.contentView.removeChildView(toolbarView);
    window.contentView.removeChildView(netflixView);
  }
  resizeViews();
  if (!toolbarView.webContents.isDestroyed()) toolbarView.webContents.send('duotela:panel-state', panelOpen);
  diagnostic('room_platform', { platform: platform || 'none', netflixVisible: platform === 'netflix' });
}

function createWindow(duoUrl) {
  window = new BaseWindow({
    title: 'Dalari Cine · teste de reprodução integrada',
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#090b12',
    ...(fs.existsSync(path.join(__dirname, 'assets', 'icon.png')) ? { icon: path.join(__dirname, 'assets', 'icon.png') } : {})
  });

  duoView = makeView('persist:duotela-local', path.join(__dirname, 'src', 'duotela-preload.cjs'));
  netflixView = makeView('persist:duotela-netflix-spike', path.join(__dirname, 'src', 'netflix-preload.cjs'));
  toolbarView = makeView('duotela-toolbar-spike', path.join(__dirname, 'src', 'toolbar-preload.cjs'));
  toolbarView.setBackgroundColor('#00000000');
  const duoSession = session.fromPartition('persist:duotela-local');
  const allowDuoMicrophone = (contents, permission, url, mediaTypes) =>
    contents === duoView?.webContents && !!duoUrl && sameDuoTelaOrigin(url, duoUrl.origin) &&
    (permission === 'speaker-selection' ||   // escolher a saída de áudio da conversa
      (permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every(type => type === 'audio')));
  duoSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const permitted = allowDuoMicrophone(contents, permission, details?.requestingUrl || details?.securityOrigin, details?.mediaTypes);
    diagnostic('permission_request', { view: 'Dalari Cine', permission, host: hostOnly(details?.requestingUrl), permitted });
    callback(permitted);
  });
  duoSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    allowDuoMicrophone(contents, permission, details?.requestingUrl || requestingOrigin, [details?.mediaType]));
  const netflixSession = session.fromPartition('persist:duotela-netflix-spike');
  const netflixPermission = (permission, url) =>
    netflixNavigationAllowed(url) &&
    ['mediaKeySystem', 'protectedMediaIdentifier', 'storage-access'].includes(permission);
  netflixSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const permitted = netflixPermission(permission, details?.requestingUrl);
    diagnostic('permission_request', { view: 'Netflix', permission, host: hostOnly(details?.requestingUrl), permitted });
    callback(permitted);
  });
  netflixSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    netflixPermission(permission, details?.requestingUrl || requestingOrigin));
  window.contentView.addChildView(duoView);
  resizeViews();
  window.on('resize', resizeViews);
  const acceptRoomPlatform = (event, platform) => {
    if (event.sender !== duoView?.webContents || !duoUrl || !sameDuoTelaOrigin(event.sender.getURL(), duoUrl.origin)) return;
    if (platform !== null && !['youtube', 'netflix', 'prime', 'crunchyroll'].includes(platform)) return;
    setRoomPlatform(platform);
  };
  ipcMain.on('duotela:room-platform', acceptRoomPlatform);
  const fromDuo = event => event.sender === duoView?.webContents && !!duoUrl && sameDuoTelaOrigin(event.sender.getURL(), duoUrl.origin);
  const acceptDuck = (event, gain) => {
    if (!fromDuo(event) || typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 1) return;
    if (netflixView && !netflixView.webContents.isDestroyed()) netflixView.webContents.send('duotela:duck', gain);
  };
  ipcMain.on('duotela:duck', acceptDuck);
  const acceptPttKey = (event, code) => {
    if (!fromDuo(event) || !(code === null || (typeof code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(code)))) return;
    pttCode = code;
  };
  ipcMain.on('duotela:ptt-key', acceptPttKey);
  const acceptOpenExternal = (event, url) => { if (fromDuo(event) && isAllowedExternal(url)) shell.openExternal(url).catch(() => {}); };
  ipcMain.on('duotela:open-external', acceptOpenExternal);
  const acceptJoinReady = event => { if (fromDuo(event)) { joinReady = true; flushJoin(); } };
  ipcMain.on('duotela:join-ready', acceptJoinReady);
  // Descobrir → "Procurar na Netflix": a janela da Netflix abre a busca com o nome do título (só a interface do Dalari Cine pode pedir)
  const acceptNetflixSearch = (event, title) => {
    const url = fromDuo(event) ? netflixSearchUrl(title) : null;
    if (!url || netflixView.webContents.isDestroyed()) return;
    // A janela da Netflix só existe quando a sala está em modo Netflix; antes disso a busca fica guardada e abre junto com ela
    if (roomPlatform === 'netflix') netflixView.webContents.loadURL(url).catch(() => {});
    else pendingNetflixSearch = url;
  };
  ipcMain.on('duotela:netflix-search', acceptNetflixSearch);
  // Cópia de segurança das configurações: o preload restaura na abertura (síncrono, antes dos scripts da página) e envia mudanças.
  const settingsLoad = event => { event.returnValue = event.sender === duoView?.webContents ? settingsStore.readBackup({ fs, dir: profileDir }) : {}; };
  const settingsSave = (event, data) => { if (event.sender === duoView?.webContents) settingsStore.writeBackup({ fs, dir: profileDir, data }); };
  ipcMain.on('duotela:settings-load', settingsLoad);
  ipcMain.on('duotela:settings-save', settingsSave);
  ipcMain.handle('duotela:update-get', event => (fromDuo(event) && updater ? updater.getState() : null));
  ipcMain.handle('duotela:update-check', event => (fromDuo(event) && updater ? updater.check({ manual: true }) : null));
  ipcMain.handle('duotela:update-install', event => (fromDuo(event) && updater ? updater.install() : null));
  ipcMain.handle('duotela:update-requirement', event => (fromDuo(event) && updater ? updater.requirement() : null));
  ipcMain.handle('duotela:update-auto', (event, on) => { if (!fromDuo(event) || !updater) return null; updater.setAuto(on === true); return updater.getState(); });
  // Com a Netflix em foco as teclas não chegam à interface: repassa só a tecla de falar escolhida (apertar/soltar).
  netflixView.webContents.on('before-input-event', (_event, input) => {
    if (!pttCode || input.code !== pttCode || input.isAutoRepeat || (input.type !== 'keyDown' && input.type !== 'keyUp')) return;
    if (duoView && !duoView.webContents.isDestroyed()) duoView.webContents.send('duotela:ptt', input.type === 'keyDown');
  });
  // Perdeu o foco com a tecla apertada: solta (o "tecla solta" iria para outra janela)
  window.on('blur', () => { if (duoView && !duoView.webContents.isDestroyed()) duoView.webContents.send('duotela:ptt', false); });
  const acceptNetflixRoomState = (event, state) => {
    if (event.sender !== duoView?.webContents || !duoUrl || !sameDuoTelaOrigin(event.sender.getURL(), duoUrl.origin) || roomPlatform !== 'netflix') return;
    if (state === null) { netflixRoomState = null; netflixView.webContents.send('duotela:netflix-state', null); return; }
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.platform !== 'netflix' || state.status !== 'active' || !/^\d{6}$/.test(state.code) || !['host', 'guest', 'guest2', 'guest3'].includes(state.you) || !Number.isSafeInteger(state.revision) || state.revision < 0) return;
    const media = state.media;
    if (media !== null && (typeof media !== 'object' || media.provider !== 'netflix' || media.titleId !== state.selectedMatch || !/^[0-9]{1,12}$/.test(media.watchId))) return;
    const playback = state.playback;
    if (media && (typeof playback !== 'object' || playback.titleId !== media.titleId || playback.watchId !== media.watchId || !['playing', 'paused'].includes(playback.state) || !Number.isFinite(playback.positionSec) || playback.positionSec < 0 || playback.positionSec > 86400 || !Number.isSafeInteger(playback.version) || playback.version < 1 || !Number.isFinite(playback.updatedAt) || !Number.isFinite(state.serverTime))) return;
    const prior = netflixRoomState;
    if (prior?.code === state.code && state.revision < prior.revision) return;
    netflixRoomState = { code: state.code, you: state.you, revision: state.revision, selectedMatch: state.selectedMatch, media: media ? { titleId: media.titleId, watchId: media.watchId } : null, playback: media ? { state: playback.state, positionSec: playback.positionSec, version: playback.version, updatedAt: playback.updatedAt, updatedBy: playback.updatedBy, syncId: Number.isSafeInteger(playback.syncId) && playback.syncId > 0 ? playback.syncId : 0 } : null, serverTime: state.serverTime };
    if (media && (prior?.code !== state.code || prior?.media?.watchId !== media.watchId)) {
      const current = netflixView.webContents.getURL();
      const currentWatch = /^\/watch\/([0-9]{1,12})(?:\/|$)/.exec((() => { try { return new URL(current).pathname; } catch { return ''; } })())?.[1];
      if (currentWatch !== media.watchId) netflixView.webContents.loadURL(`https://www.netflix.com/watch/${media.watchId}`).catch(() => {});
    }
    netflixView.webContents.send('duotela:netflix-state', netflixRoomState);
  };
  ipcMain.on('duotela:netflix-room-state', acceptNetflixRoomState);
  const relayNetflixEvent = (event, report) => {
    if (event.sender !== netflixView?.webContents || roomPlatform !== 'netflix' || !netflixNavigationAllowed(event.sender.getURL()) || !report || !/^[0-9]{1,12}$/.test(report.watchId)) return;
    const routeWatch = /^\/watch\/([0-9]{1,12})\/?$/.exec(new URL(event.sender.getURL()).pathname)?.[1];
    if (routeWatch !== report.watchId) return;
    if (!['detected', 'play', 'pause', 'seek', 'status'].includes(report.type)) return;
    if (report.type !== 'detected' && report.type !== 'status' && (!netflixRoomState?.media || report.watchId !== netflixRoomState.media.watchId || !Number.isFinite(report.positionSec) || report.positionSec < 0 || report.positionSec > 86400)) return;
    duoView.webContents.send('duotela:netflix-event', { type: report.type, watchId: report.watchId, positionSec: report.positionSec, playing: report.playing === true, status: typeof report.status === 'string' ? report.status.slice(0, 40) : undefined });
  };
  ipcMain.on('duotela:netflix-report', relayNetflixEvent);
  const toolbarSession = session.fromPartition('duotela-toolbar-spike');
  toolbarSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  toolbarSession.setPermissionCheckHandler(() => false);
  const toolbarPath = path.join(__dirname, 'src', 'toolbar.html');
  const toolbarUrl = pathToFileURL(toolbarPath).href;
  restrictNavigation(toolbarView.webContents, raw => raw === toolbarUrl, 'Controles');
  toolbarView.webContents.on('did-finish-load', () => {
    toolbarView.webContents.send('duotela:panel-state', panelOpen);
  });
  toolbarView.webContents.loadFile(toolbarPath).catch(() => {});
  const togglePanel = event => {
    if (event.sender !== toolbarView?.webContents) return;
    setPanel(!panelOpen);
  };
  ipcMain.on('duotela:toggle-panel', togglePanel);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Dalari Cine', submenu: [
      { label: 'Mostrar/ocultar sala', accelerator: 'CmdOrCtrl+Shift+S', click: () => setPanel(!panelOpen) },
      { label: 'Estatísticas para nerds', accelerator: 'CmdOrCtrl+Alt+N', click: () => { if (duoView && !duoView.webContents.isDestroyed()) duoView.webContents.executeJavaScript("window.dispatchEvent(new CustomEvent('duotela:nerd'))").catch(() => {}); } },
      { label: 'Verificar atualizações', click: () => { if (updater) updater.check({ manual: true }).catch(() => {}); } },
      { type: 'separator' },
      { role: 'quit' }
    ] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]));

  if (duoUrl) {
    restrictNavigation(duoView.webContents, raw => sameDuoTelaOrigin(raw, duoUrl.origin), 'Dalari Cine');
    duoView.webContents.loadURL(duoUrl.href).catch(() => {});
  } else {
    const instructionPath = path.join(__dirname, 'src', 'instructions.html');
    const instructionUrl = pathToFileURL(instructionPath).href;
    restrictNavigation(duoView.webContents, raw => raw === instructionUrl, 'Dalari Cine');
    duoView.webContents.loadFile(instructionPath).catch(() => {});
  }
  restrictNavigation(netflixView.webContents, netflixNavigationAllowed, 'Netflix');
  netflixView.webContents.on('did-finish-load', () => {
    if (roomPlatform === 'netflix' && netflixRoomState) netflixView.webContents.send('duotela:netflix-state', netflixRoomState);
  });

  window.on('closed', () => {
    ipcMain.removeListener('duotela:toggle-panel', togglePanel);
    ipcMain.removeListener('duotela:room-platform', acceptRoomPlatform);
    ipcMain.removeListener('duotela:duck', acceptDuck);
    ipcMain.removeListener('duotela:ptt-key', acceptPttKey);
    ipcMain.removeListener('duotela:open-external', acceptOpenExternal);
    ipcMain.removeListener('duotela:join-ready', acceptJoinReady);
    joinReady = false;
    ipcMain.removeListener('duotela:netflix-search', acceptNetflixSearch);
    ipcMain.removeListener('duotela:settings-load', settingsLoad);
    ipcMain.removeListener('duotela:settings-save', settingsSave);
    for (const channel of ['duotela:update-get', 'duotela:update-check', 'duotela:update-install', 'duotela:update-requirement', 'duotela:update-auto']) ipcMain.removeHandler(channel);
    ipcMain.removeListener('duotela:netflix-room-state', acceptNetflixRoomState);
    ipcMain.removeListener('duotela:netflix-report', relayNetflixEvent);
    if (!duoView.webContents.isDestroyed()) duoView.webContents.close();
    if (!netflixView.webContents.isDestroyed()) netflixView.webContents.close();
    if (!toolbarView.webContents.isDestroyed()) toolbarView.webContents.close();
    window = null;
    duoView = null;
    netflixView = null;
    toolbarView = null;
    roomPlatform = null;
    netflixLoaded = false;
    netflixRoomState = null;
  });
  diagnostic('window_opened', { embedded: true, netflixHost: 'www.netflix.com', duoTelaOrigin: duoUrl?.origin || 'local-instructions' });
}

app.whenReady().then(async () => {
  if (!gotInstanceLock) return;
  let duoUrl;
  try {
    if (configuredDuoUrlError) throw configuredDuoUrlError;
    duoUrl = configuredDuoUrl || parseDuoTelaUrl(await startStableServer());
    if (lanOrigin) diagnostic('lan_mode', { origin: lanOrigin, microphoneOriginTreatedAsSecure: true });
  } catch (error) {
    dialog.showErrorBox('Serviço Dalari Cine indisponível', error.message);
    app.quit();
    return;
  }

  try {
    await components.whenReady();
    const list = Object.values(components.status()).map(item => ({ title: item.title, status: item.status, version: item.version }));
    diagnostic('components_ready', { components: list });
  } catch (error) {
    diagnostic('components_failed', { message: error?.code || error?.name || 'unknown' });
    dialog.showErrorBox('DRM indisponível', 'O módulo de reprodução protegida não ficou pronto. Consulte o diagnóstico no terminal.');
    app.quit();
    return;
  }
  updater = createUpdater({
    config: readUpdateConfig(), current: app.getVersion(), platform: process.platform, arch: process.arch,
    fetch: (url, init) => net.fetch(url, init), tmpDir: app.getPath('temp'),
    launchInstaller, quit: () => app.quit(), emit: sendUpdateState, store: updateStore
  });
  createWindow(duoUrl);
  if (app.isPackaged) updater.start();
  diagnostic('updater', { enabled: updater.getState().enabled, auto: updater.getState().auto });
}).catch(error => {
  diagnostic('startup_failed', { message: error?.code || error?.name || 'unknown' });
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (bundledServer) bundledServer.kill(); });
