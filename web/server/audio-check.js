/* Assistente de áudio e conexão: aviso de fone, teste de microfone com medidor, teste da saída e "Testar minha conexão".
   Abre sozinho uma vez depois das boas-vindas (pode pular) e a qualquer momento em Perfil → Testar áudio e conexão.
   A lógica de decisão (nível do microfone, tipo de rede) é pura e testada à parte; a janela só liga isso aos recursos do navegador. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DuoAudioCheck = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREF_KEY = 'duotela-audio-devices';          // a mesma chave que a chamada de voz lê
  const FLAG_KEY = 'duotela-audio-wizard-v1';
  const STUN_A = 'stun:stun.l.google.com:19302', STUN_B = 'stun:stun1.l.google.com:19302';
  const DEFAULT_RELAY = 'https://ntfy.sh';

  // ---------- lógica pura ----------
  /** Volume (RMS 0..1) de um bloco de amostras de 8 bits do AnalyserNode (128 = silêncio). */
  function rmsOf(bytes) {
    if (!bytes || !bytes.length) return 0;
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) { const v = (bytes[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / bytes.length);
  }
  /** Resultado do teste do microfone a partir do pico de volume durante a escuta. */
  function classifyMic(peak) {
    const p = Number(peak) || 0;
    if (p >= 0.05) return { level: 'ok', text: 'Ouvimos você bem. O microfone está funcionando.' };
    if (p >= 0.015) return { level: 'low', text: 'Ouvimos você, mas muito baixo. Chegue mais perto do microfone ou aumente o volume de entrada do sistema.' };
    return { level: 'silent', text: 'Não ouvimos nada. Confira se o microfone certo está escolhido, se não está mudo (no computador ou no fone) e se o app tem permissão de microfone.' };
  }
  /** Lê uma linha "a=candidate:..." ou o texto de um RTCIceCandidate. */
  function parseCandidate(line) {
    const m = /candidate:\S+ \d+ (udp|tcp) \d+ (\S+) (\d+) typ (host|srflx|prflx|relay)/i.exec(String(line || ''));
    return m ? { proto: m[1].toLowerCase(), ip: m[2], port: Number(m[3]), type: m[4].toLowerCase() } : null;
  }
  const isPublicIp = (ip) => !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|fe80:|fc|fd|.*\.local$)/i.test(ip);
  /** Une o que foi medido num veredito em linguagem simples. Cada entrada de a/b é o candidato srflx visto num servidor STUN (ou null). */
  function classifyNetwork({ srflxA, srflxB, relayOk, relayMs } = {}) {
    const items = [];
    let level = 'good';
    const worse = (l) => { const order = { good: 0, warn: 1, hard: 2 }; if (order[l] > order[level]) level = l; };
    if (!srflxA) {
      items.push({ ok: false, text: 'Não conseguimos descobrir o seu endereço público (o tráfego UDP parece bloqueado). A voz direta provavelmente não vai conectar nesta rede.' });
      worse('hard');
    } else {
      items.push({ ok: true, text: 'Conseguimos descobrir o seu endereço na internet: a conexão direta é possível.' });
      if (srflxB) {
        if (srflxA.ip === srflxB.ip && srflxA.port === srflxB.port) items.push({ ok: true, text: 'Sua rede mantém o mesmo caminho para todos os destinos (bom para voz direta).' });
        else if (srflxA.ip === srflxB.ip) { items.push({ ok: false, text: 'Sua rede muda o caminho a cada destino (NAT "simétrico"). A voz pode não conectar com algumas redes, e o app ainda não tem servidor de retransmissão (TURN).' }); worse('warn'); }
        else { items.push({ ok: false, text: 'Sua rede usa endereços públicos diferentes para cada destino (rede compartilhada). A voz direta pode falhar.' }); worse('warn'); }
      }
      if (!isPublicIp(srflxA.ip)) { items.push({ ok: false, text: 'O endereço visto parece privado: sua operadora pode usar CGNAT, o que atrapalha conexões diretas.' }); worse('warn'); }
    }
    if (relayOk === false) { items.push({ ok: false, text: 'O serviço de encontro do código curto (ntfy.sh) não respondeu. O código curto pode falhar; o convite longo ainda funciona.' }); worse('warn'); }
    else if (relayOk === true) {
      const slow = Number.isFinite(relayMs) && relayMs > 1500;
      items.push({ ok: !slow, text: slow ? `O serviço de encontro respondeu devagar (${Math.round(relayMs)} ms). O código curto pode demorar.` : `O serviço de encontro do código curto respondeu (${Math.round(relayMs || 0)} ms).` });
      if (slow) worse('warn');
    }
    const title = level === 'good' ? 'Sua conexão está boa para voz' : level === 'warn' ? 'Sua conexão deve funcionar, com ressalvas' : 'Esta rede deve dar problema na voz';
    return { level, title, items };
  }

  const storage = (win) => { try { return win.localStorage; } catch { return null; } };
  const hasSeen = (win) => { try { return storage(win)?.getItem(FLAG_KEY) === '1'; } catch { return false; } };
  const markSeen = (win) => { try { storage(win)?.setItem(FLAG_KEY, '1'); } catch { /* sem armazenamento */ } };
  function loadPrefs(win) { try { const p = JSON.parse(storage(win)?.getItem(PREF_KEY) || '{}'); return { input: typeof p.input === 'string' ? p.input : '', output: typeof p.output === 'string' ? p.output : '' }; } catch { return { input: '', output: '' }; } }
  function savePrefs(win, patch) { try { storage(win)?.setItem(PREF_KEY, JSON.stringify({ ...loadPrefs(win), ...patch })); } catch { /* sem armazenamento */ } }

  // ---------- medições no navegador ----------
  /** Descobre o endereço público visto por um servidor STUN (candidato srflx) ou null. */
  async function srflxVia(win, stun, timeoutMs = 4500) {
    const pc = new win.RTCPeerConnection({ iceServers: [{ urls: stun }] });
    try {
      pc.createDataChannel('x');
      const found = new Promise((resolve) => {
        const timer = win.setTimeout(() => resolve(null), timeoutMs);
        pc.onicecandidate = (e) => {
          if (!e.candidate) { win.clearTimeout(timer); resolve(null); return; }
          const c = parseCandidate(e.candidate.candidate);
          if (c && c.type === 'srflx') { win.clearTimeout(timer); resolve(c); }
        };
      });
      await pc.setLocalDescription(await pc.createOffer());
      return await found;
    } finally { try { pc.close(); } catch { /* já fechado */ } }
  }
  async function probeRelay(win, base) {
    const t0 = win.performance.now();
    try {
      const ctl = new win.AbortController(); const timer = win.setTimeout(() => ctl.abort(), 6000);
      const res = await win.fetch(base.replace(/\/+$/, '') + '/v1/health', { cache: 'no-store', signal: ctl.signal });
      win.clearTimeout(timer);
      return { ok: res.ok, ms: win.performance.now() - t0 };
    } catch { return { ok: false, ms: win.performance.now() - t0 }; }
  }
  async function testConnection(win) {
    if (typeof win.RTCPeerConnection === 'undefined') return { level: 'hard', title: 'Este navegador não suporta voz', items: [{ ok: false, text: 'Não há suporte a WebRTC aqui.' }] };
    let relayBase = DEFAULT_RELAY; try { relayBase = storage(win)?.getItem('duotela-relay') || DEFAULT_RELAY; } catch { /* padrão */ }
    const [a, b, relay] = await Promise.all([srflxVia(win, STUN_A).catch(() => null), srflxVia(win, STUN_B).catch(() => null), probeRelay(win, relayBase)]);
    return classifyNetwork({ srflxA: a, srflxB: b, relayOk: relay.ok, relayMs: relay.ms });
  }

  // ---------- janela ----------
  function css() {
    return '.ac-dialog{width:min(560px,calc(100vw - 28px))}.ac-steps{display:flex;gap:6px;margin:0 0 14px}.ac-steps i{flex:1;height:4px;border-radius:4px;background:#344050}.ac-steps i.on{background:#FFAC8F}'
      + '.ac-box{padding:12px 14px;border:1px solid #344050;border-radius:14px;background:#0f1522;margin:10px 0}.ac-box p{margin:0 0 6px}.ac-box p:last-child{margin:0}'
      + '.ac-warn{border-color:#FFAC8F77;background:#ffac8f10}.ac-ok{color:#bff3d6}.ac-bad{color:#ffb4a8}.ac-meter{height:14px;border-radius:8px;background:#0b101c;border:1px solid #344050;overflow:hidden;margin:8px 0}'
      + '.ac-meter b{display:block;height:100%;width:0;background:linear-gradient(90deg,#6ee7a8,#FFAC8F);transition:width .06s linear}'
      + '.ac-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}.ac-dialog select{max-width:100%;padding:8px 10px;border-radius:10px;border:1px solid #344050;background:#0f1522;color:#f5f2f5;font:inherit}'
      + '.ac-list{margin:6px 0 0;padding:0;list-style:none}.ac-list li{margin:5px 0;padding-left:22px;position:relative}.ac-list li::before{content:"\\2713";position:absolute;left:0;color:#6ee7a8}.ac-list li.no::before{content:"!";color:#FFAC8F;font-weight:800}';
  }

  /** Abre o assistente. Resolve quando a pessoa fecha. firstRun: mostra "Pular por agora" e marca como visto ao fechar. */
  function open({ win = (typeof window !== 'undefined' ? window : null), firstRun = false, onClose } = {}) {
    if (!win || !win.document) return null;
    const doc = win.document;
    if (doc.querySelector('.ac-dialog')) return null;
    const style = doc.createElement('style'); style.textContent = css(); doc.head.append(style);
    const el = (tag, text, attrs = {}) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const dlg = el('dialog', undefined, { class: 'duo-dialog ac-dialog', 'aria-labelledby': 'ac-title' });
    const STEPS = ['fone', 'mic', 'saida', 'rede'];
    const result = { mic: null, out: null, net: null };
    let step = 0, stream = null, ctx = null, raf = 0, closed = false;

    const stopMic = () => { if (raf) win.cancelAnimationFrame(raf); raf = 0; if (stream) for (const t of stream.getTracks()) t.stop(); stream = null; if (ctx) { ctx.close().catch(() => {}); ctx = null; } };
    function close() {
      if (closed) return; closed = true;
      stopMic(); markSeen(win);
      try { dlg.close(); } catch { /* já fechado */ }
      dlg.remove(); style.remove(); onClose?.(result);
    }
    const btn = (label, onClick, main = false) => { const b = el('button', label, { type: 'button', class: 'duo-btn' + (main ? ' main' : '') }); b.addEventListener('click', onClick); return b; };
    const go = (n) => { stopMic(); step = n; draw(); };
    const head = (title, lead) => {
      const steps = el('div', undefined, { class: 'ac-steps', 'aria-hidden': 'true' });
      STEPS.forEach((_, i) => steps.append(el('i', undefined, { class: i <= step ? 'on' : '' })));
      dlg.append(steps, el('h2', title, { id: 'ac-title' }), el('p', lead, { class: 'lead' }));
    };
    const nav = (back, next, nextLabel = 'Continuar') => {
      const row = el('div', undefined, { class: 'duo-actions' });
      if (back) row.append(btn('Voltar', () => go(step - 1)));
      row.append(btn(nextLabel, next, true));
      if (firstRun && step < STEPS.length) row.append(btn('Pular por agora', close));
      dlg.append(row);
    };
    async function deviceList(kind) {
      try { const all = await win.navigator.mediaDevices.enumerateDevices(); return all.filter((d) => d.kind === kind); } catch { return []; }
    }
    const fillSelect = (select, devices, current, fallback) => {
      select.replaceChildren(el('option', fallback, { value: '' }));
      devices.forEach((d, i) => { if (d.deviceId === 'default' || d.deviceId === 'communications') return; select.append(el('option', d.label || `${fallback} ${i + 1}`, { value: d.deviceId })); });
      select.value = devices.some((d) => d.deviceId === current) ? current : '';
    };

    function drawFone() {
      head('Antes de tudo: use fones', 'Um minuto para deixar o áudio certo.');
      const box = el('div', undefined, { class: 'ac-box ac-warn' });
      box.append(el('p', '\u{1F3A7} Use fones de ouvido (ou um headset).'), el('p', 'Sem fone, o microfone capta o som do filme que sai da caixa de som e a outra pessoa ouve tudo de volta, como eco. O app já corta parte do eco, mas o fone resolve de vez, e ainda deixa o filme e a voz mais claros.'));
      dlg.append(box);
      nav(false, () => go(1));
    }
    async function drawMic() {
      head('Teste do microfone', 'Fale normalmente, como numa chamada. O medidor deve se mexer.');
      const sel = el('select', undefined, { 'aria-label': 'Microfone' });
      const meter = el('div', undefined, { class: 'ac-meter', 'aria-hidden': 'true' }), bar = el('b'); meter.append(bar);
      const msg = el('p', 'Clique em Testar. O navegador pode pedir permissão para usar o microfone: é só para o medidor; nada é gravado nem enviado.', { role: 'status' });
      const row = el('div', undefined, { class: 'ac-row' });
      const prefs = loadPrefs(win);
      let peak = 0;
      const run = btn('Testar microfone', async () => {
        stopMic(); peak = 0; bar.style.width = '0'; msg.className = ''; msg.textContent = 'Pedindo acesso ao microfone…';
        try {
          const audio = prefs.input && sel.value ? { deviceId: { exact: sel.value } } : true;
          stream = await win.navigator.mediaDevices.getUserMedia({ audio, video: false });
          fillSelect(sel, await deviceList('audioinput'), (stream.getAudioTracks()[0]?.getSettings?.().deviceId) || sel.value, 'Microfone padrão do sistema');
          const AC = win.AudioContext || win.webkitAudioContext; ctx = new AC();
          const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
          const data = new Uint8Array(an.fftSize), t0 = win.performance.now();
          msg.textContent = 'Ouvindo… fale alguma coisa (por uns 5 segundos).';
          const loop = () => {
            an.getByteTimeDomainData(data);
            const v = rmsOf(data); peak = Math.max(peak, v);
            bar.style.width = Math.min(100, Math.round(v * 400)) + '%';
            if (win.performance.now() - t0 < 5500) raf = win.requestAnimationFrame(loop);
            else { const r = classifyMic(peak); result.mic = r.level; msg.className = r.level === 'ok' ? 'ac-ok' : 'ac-bad'; msg.textContent = (r.level === 'ok' ? '✓ ' : '! ') + r.text; stopMic(); }
          };
          loop();
        } catch (e) {
          result.mic = 'denied'; msg.className = 'ac-bad';
          msg.textContent = e?.name === 'NotAllowedError' ? 'O acesso ao microfone foi negado. Libere nas permissões do sistema/navegador e tente de novo.' : e?.name === 'NotFoundError' ? 'Nenhum microfone encontrado. Conecte um e tente de novo.' : 'Não foi possível abrir o microfone: ' + (e?.message || e?.name || 'erro');
        }
      }, true);
      sel.addEventListener('change', () => { savePrefs(win, { input: sel.value }); prefs.input = sel.value; });
      row.append(sel, run);
      dlg.append(row, meter, msg);
      const inputs = await deviceList('audioinput');
      if (!closed && step === 1) fillSelect(sel, inputs, prefs.input, 'Microfone padrão do sistema');
      nav(true, () => go(2));
    }
    async function drawSaida() {
      head('Teste da saída de áudio', 'Vamos tocar um sonzinho no fone ou na caixa de som.');
      const sel = el('select', undefined, { 'aria-label': 'Saída de áudio' });
      const msg = el('p', 'Clique em Tocar som e diga se você ouviu.', { role: 'status' });
      const prefs = loadPrefs(win);
      const canSink = typeof win.HTMLMediaElement?.prototype?.setSinkId === 'function';
      const row = el('div', undefined, { class: 'ac-row' });
      const play = btn('▶ Tocar som', async () => {
        try {
          const AC = win.AudioContext || win.webkitAudioContext; const c = new AC();
          const dest = c.createMediaStreamDestination(), audio = new win.Audio(); audio.srcObject = dest.stream;
          if (canSink && sel.value) await audio.setSinkId(sel.value);
          const t = c.currentTime;
          [[523.25, 0], [659.25, 0.28], [783.99, 0.56]].forEach(([f, at]) => {
            const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = f;
            g.gain.setValueAtTime(0, t + at); g.gain.linearRampToValueAtTime(0.25, t + at + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + at + 0.5);
            o.connect(g).connect(dest); o.start(t + at); o.stop(t + at + 0.55);
          });
          await audio.play();
          msg.className = ''; msg.textContent = 'Tocando… você ouviu?';
          win.setTimeout(() => { c.close().catch(() => {}); audio.srcObject = null; yn.hidden = false; msg.textContent = 'Você ouviu o som?'; }, 1500);
        } catch (e) { msg.className = 'ac-bad'; msg.textContent = 'Não foi possível tocar o som: ' + (e?.message || e?.name || 'erro'); }
      }, true);
      const yn = el('div', undefined, { class: 'ac-row' }); yn.hidden = true;
      yn.append(btn('Sim, ouvi', () => { result.out = 'ok'; msg.className = 'ac-ok'; msg.textContent = '✓ Ótimo, a saída está funcionando.'; yn.hidden = true; }), btn('Não ouvi', () => { result.out = 'silent'; msg.className = 'ac-bad'; msg.textContent = '! Escolha outra saída na lista, confira o volume do computador e do fone, e toque de novo.'; yn.hidden = true; }));
      if (canSink) { row.append(sel); sel.addEventListener('change', () => savePrefs(win, { output: sel.value })); }
      row.append(play);
      dlg.append(row, msg, yn);
      if (!canSink) dlg.append(el('p', 'Este navegador não deixa escolher a saída: o som vai para a saída padrão do sistema.', { class: 'lead' }));
      else { const outs = await deviceList('audiooutput'); if (!closed && step === 2) fillSelect(sel, outs, prefs.output, 'Saída padrão do sistema'); }
      nav(true, () => go(3));
    }
    function drawRede() {
      head('Teste da conexão', 'Vemos se a sua rede deixa a voz conectar com a outra pessoa.');
      const box = el('div', undefined, { class: 'ac-box' });
      const msg = el('p', 'Clique em Testar minha conexão. Leva uns 5 segundos.', { role: 'status' });
      box.append(msg);
      const run = btn('Testar minha conexão', async () => {
        run.disabled = true; msg.className = ''; msg.textContent = 'Testando…'; box.querySelector('ul')?.remove();
        try {
          const r = await testConnection(win); result.net = r.level;
          msg.className = r.level === 'good' ? 'ac-ok' : 'ac-bad'; msg.textContent = (r.level === 'good' ? '✓ ' : '! ') + r.title;
          const ul = el('ul', undefined, { class: 'ac-list' });
          for (const it of r.items) ul.append(el('li', it.text, { class: it.ok ? '' : 'no' }));
          box.append(ul);
        } catch (e) { msg.className = 'ac-bad'; msg.textContent = 'Não foi possível testar: ' + (e?.message || 'erro'); }
        run.disabled = false; run.textContent = 'Testar de novo';
      }, true);
      dlg.append(el('div', undefined, { class: 'ac-row' }), box);
      dlg.querySelector('.ac-row').append(run);
      dlg.append(el('p', 'O teste só consulta servidores públicos de rede (o do Google para descobrir seu endereço e o do código curto). Nada do que você diz ou assiste é enviado.', { class: 'lead' }));
      nav(true, () => close(), 'Concluir');
    }
    function draw() {
      dlg.replaceChildren();
      [drawFone, drawMic, drawSaida, drawRede][step]();
    }
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    doc.body.append(dlg); dlg.showModal(); draw();
    return { close };
  }

  return { open, hasSeen, markSeen, rmsOf, classifyMic, parseCandidate, classifyNetwork, testConnection, FLAG_KEY, PREF_KEY };
});
