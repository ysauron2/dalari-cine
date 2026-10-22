// Mini cliente do Chrome DevTools Protocol, sem dependências (WebSocket global do Node 24).
// Só para testes locais: lança o Chromium já instalado em um perfil temporário e controla abas.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CHROMIUM = process.env.DUOTELA_CHROMIUM || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe');

export async function launch({ args = [], headless = true, autoplay = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'duotela-cdp-'));
  const proc = spawn(CHROMIUM, [
    `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(autoplay ? ['--autoplay-policy=no-user-gesture-required'] : []),
    '--disable-features=DisableLoadExtensionCommandLineSwitch', '--enable-unsafe-extension-debugging',
    ...(headless ? ['--headless=new'] : []), ...args, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chromium não anunciou a porta de depuração')), 20000);
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.on('exit', (c) => reject(new Error('Chromium saiu: ' + c)));
  });
  const browser = new Cdp(wsUrl);
  await browser.open();
  return {
    browser, proc,
    async close() { try { await browser.send('Browser.close'); } catch { /* já fechou */ } proc.kill(); await new Promise((r) => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); },
  };
}

export class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('falha no WebSocket do CDP'));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const { resolve: ok, reject: bad } = this.pending.get(m.id); this.pending.delete(m.id);
          if (m.error) bad(new Error(m.error.message)); else ok(m.result);
        } else if (m.method) for (const l of this.listeners) l(m);
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.push(fn); }
  /** Abre uma aba e devolve um objeto com evaluate/screenshot/close. */
  async page(url, { contextId } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', ...(contextId ? { browserContextId: contextId } : {}) });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => this.send(m, p, sessionId);
    const logs = [];
    this.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.consoleAPICalled') logs.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
      if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    });
    await call('Page.enable'); await call('Runtime.enable');
    const page = {
      targetId, sessionId, logs, call,
      async goto(u) { await call('Page.navigate', { url: u }); await page.waitFor(() => document.readyState === 'complete'); },
      async evaluate(fn, ...args) {
        const expr = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : fn;
        const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      async waitFor(fn, ...args) {
        for (let i = 0; i < 100; i++) { try { if (await page.evaluate(fn, ...args)) return true; } catch { /* página navegando */ } await new Promise((r) => setTimeout(r, 100)); }
        throw new Error('waitFor expirou: ' + fn.toString().slice(0, 120) + '\n' + logs.slice(-5).join('\n'));
      },
      async screenshot(file, { width, height } = {}) {
        if (width) await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        const { data } = await call('Page.captureScreenshot', { format: 'png' });
        const { writeFile } = await import('node:fs/promises');
        await writeFile(file, Buffer.from(data, 'base64'));
      },
      /** Responde TODAS as requisições da aba localmente (nada sai para a rede): handler(url) => {status, headers, body} | null. */
      async intercept(handler) {
        await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        page.cdp.on((m) => {
          if (m.sessionId !== sessionId || m.method !== 'Fetch.requestPaused') return;
          const r = m.params, res = handler(r.request.url, r.request);
          if (res) call('Fetch.fulfillRequest', { requestId: r.requestId, responseCode: res.status || 200, responseHeaders: Object.entries(res.headers || {}).map(([name, value]) => ({ name, value })), body: Buffer.from(res.body || '').toString('base64') }).catch(() => {});
          else call('Fetch.failRequest', { requestId: r.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        });
      },
      async close() { await page.cdp.send('Target.closeTarget', { targetId }); },
      cdp: this,
    };
    if (url) await page.goto(url);
    return page;
  }
}
