/* Interface experimental da sala (v3): somente no serviço local ou em uma futura origem HTTPS. */
(() => {
  'use strict';
  // Cópia do convite: Clipboard API quando existir (origem segura); senão execCommand em campo temporário.
  // Retorna 'copied', 'manual' (copiar à mão) ou 'empty'. Nunca lança nem registra o texto.
  function legacyCopy(text, env) {
    const doc = env.document;
    if (typeof doc?.execCommand !== 'function' || typeof doc.createElement !== 'function') return false;
    const previous = doc.activeElement;
    let field = null;
    try {
      field = doc.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', ''); field.setAttribute('aria-hidden', 'true'); field.setAttribute('tabindex', '-1');
      field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
      (env.container || doc.body).append(field);
      field.focus({ preventScroll: true }); field.select();
      field.setSelectionRange?.(0, text.length);
      return doc.execCommand('copy') === true;
    } catch { return false; } finally {
      try { field?.remove(); previous?.focus?.({ preventScroll: true }); } catch { /* limpeza best-effort */ }
    }
  }
  async function copyText(text, env) {
    if (typeof text !== 'string' || !text) return 'empty';
    if (typeof env.navigator?.clipboard?.writeText === 'function') {
      try { await env.navigator.clipboard.writeText(text); return 'copied'; } catch { /* tenta o método compatível */ }
    }
    return legacyCopy(text, env) ? 'copied' : 'manual';
  }
  window.DuoInviteCopy = { copyText };
  const adapter = window.DuoTelaAdapter;
  const roomView = document.querySelector('#view-room');
  if (!adapter || !roomView || !window.DuoRoomClient) return;
  // Somente para teste na rede privada. Fora dela, o cliente exige HTTPS.
  const isPrivateLanHttp = () => location.protocol === 'http:' &&
    /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(location.hostname);
  const panel = document.createElement('section');
  panel.className = 'online-room';
  panel.setAttribute('aria-label', 'Sala conectada');
  panel.innerHTML = `<style>
    .online-room{--bg:#090C14;--s1:#171E2B;--s2:#202838;--coral:#FFAC8F;--green:#A6E4C6;--line:#344050;--ink:#f5f2f5;--mute:#a9b2c2;--ease:.18s ease;margin:22px 0;max-width:none}
    .online-room[hidden]{display:none}
    .online-room h3,.online-room h4,.online-room p{margin:0}.online-room p{color:var(--mute);font-size:12px;line-height:1.55}
    .online-room button{font:inherit;cursor:pointer}
    .online-room button:focus-visible,.online-room input:focus-visible,.online-room [tabindex]:focus-visible{outline:2px solid var(--coral);outline-offset:2px}
    .online-room input{width:100%;background:#0b101c;color:#fff;border:1px solid var(--line);border-radius:999px;padding:11px 15px;font:inherit;font-size:13px;transition:border-color var(--ease),background var(--ease)}
    .online-room input:hover{border-color:#4a586d}.online-room input::placeholder{color:#7d8799}
    .online-room label{display:block;color:#d6dbe6;font-size:11px;margin:9px 0 5px}
    .online-msg{min-height:20px;margin-top:10px;color:#ffd0ad!important}

    /* botões */
    .online-room .rb{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:9px 16px;border-radius:999px;border:1px solid var(--line);background:var(--s1);color:#f2f4f8;font-size:12px;font-weight:700;white-space:nowrap;transition:transform var(--ease),background var(--ease),border-color var(--ease),box-shadow var(--ease),color var(--ease)}
    .online-room .rb:hover:not(:disabled){transform:translateY(-1px);border-color:var(--coral);background:var(--s2)}
    .online-room .rb:active:not(:disabled){transform:scale(.97)}
    .online-room .rb:disabled{opacity:.5;cursor:not-allowed}
    .online-room .rb-main{background:var(--coral);border-color:transparent;color:#2b1519;box-shadow:0 6px 22px #ffac8f30}
    .online-room .rb-main:hover:not(:disabled){background:#ffbca3;border-color:transparent;box-shadow:0 9px 26px #ffac8f50}
    .online-room .rb-accent{color:var(--coral);background:#2a2230;border-color:#5a4146}
    .online-room .rb-danger{color:#ffb4b0;border-color:#6a3d44;background:#2a1b22}
    .online-room .rb-icon{width:40px;padding:0;font-size:15px}
    .online-room .rb-link{background:none;border:0;color:var(--coral);padding:4px 0;min-height:0;font-size:11px}
    .online-room .rb-link:hover:not(:disabled){background:none;transform:none;text-decoration:underline}

    /* lobby (antes de conectar) */
    .online-room .lobby{max-width:920px;padding:22px;border:1px solid var(--line);border-radius:24px;background:var(--s1)}
    .online-room .lobby h3{font-size:19px;margin-bottom:7px}
    .online-room .online-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:15px 0}
    .online-room .online-box{padding:16px;background:var(--bg);border:1px solid var(--line);border-radius:18px}
    .online-room .online-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:11px}

    /* cabeçalho */
    .rv3{display:grid;gap:18px;min-width:0}
    .rv3-head{display:flex;align-items:flex-start;gap:14px 18px;flex-wrap:wrap}
    .rv3-titles{flex:1 1 260px;min-width:0;display:grid;grid-template-columns:max-content max-content;column-gap:18px;align-items:center}
    .rv3-titles h3{font-size:clamp(26px,3vw,34px);letter-spacing:-.05em;line-height:1.1}
    .rv3-titles p{grid-column:1/-1;margin-top:4px;font-size:13px}
    .rv3-conn{grid-column:2;grid-row:1;display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;background:#1d3a31;color:var(--green);font-size:11px;font-weight:800;transition:background .22s,color .22s}
    .rv3-conn:before{content:'';width:7px;height:7px;border-radius:50%;background:var(--green)}
    .rv3-conn.is-off{background:#4b3427;color:#ffd1aa}.rv3-conn.is-off:before{background:#ffc194}
    .rv3-head-actions{display:flex;align-items:center;gap:9px;position:relative}
    .rv3-dot{position:absolute;top:-3px;right:-3px;width:11px;height:11px;border-radius:50%;background:var(--coral);border:2px solid var(--bg)}
    .rv3-menuwrap{position:relative}
    .rv3-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:20;min-width:230px;padding:8px;border-radius:18px;border:1px solid var(--line);background:var(--s2);box-shadow:0 18px 44px #0009;display:grid;gap:4px}
    .rv3-menu[hidden]{display:none}
    .rv3-menu p{padding:6px 10px;font-size:11px}
    .rv3-menu .rb{justify-content:flex-start;border-radius:12px;border-color:transparent;background:transparent}
    .rv3-chips{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
    .rv3-chips .rb[aria-pressed=true]{background:#3a2530;border-color:var(--coral);color:var(--coral)}
    .rv3-hint{color:#8b95a7;font-size:11px}
    .rv3-alert{display:grid;gap:10px;padding:20px 22px;border-radius:22px;border:1px solid var(--line);background:var(--s1)}
    .rv3-alert[hidden]{display:none}.rv3-alert h4{font-size:19px;letter-spacing:-.03em}.rv3-alert .online-row{margin-top:4px}
    .rv3-alert.is-attn{border-color:var(--coral);background:#2a2029}

    /* grade palco + painel */
    .rv3-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,368px);gap:24px;align-items:start;min-width:0}
    .rv3-grid[hidden]{display:none}
    .rv3-main{display:grid;gap:18px;min-width:0}
    .stage{border:1px solid var(--line);border-radius:24px;background:var(--s1);overflow:hidden;min-width:0}
    .stage-view{position:relative;aspect-ratio:16/9;background:#10172a;isolation:isolate;overflow:hidden}
    .stage-view .light{position:absolute;border-radius:50%;pointer-events:none;z-index:-1;transition:transform .6s ease}
    .stage-view .l1{width:62%;aspect-ratio:1;right:-14%;top:-48%;background:#1b2440}
    .stage-view .l2{width:46%;aspect-ratio:1;left:-12%;bottom:-62%;background:#262434}
    .stage-badges{position:absolute;left:18px;right:18px;top:16px;z-index:3;display:flex;justify-content:space-between;gap:10px;pointer-events:none}
    .stage-badge{display:inline-flex;align-items:center;gap:7px;max-width:60%;padding:6px 12px;border-radius:999px;background:#0b101ccc;color:var(--coral);font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;backdrop-filter:blur(8px)}
    .stage-sync{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;background:#17342b;color:var(--green);font-size:10px;font-weight:800;backdrop-filter:blur(8px)}
    .stage-sync:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--green)}
    .stage-sync.is-wait{background:#40302a;color:#ffd1aa}.stage-sync.is-wait:before{background:#ffc194}
    .stage-sync[hidden],.stage-badge[hidden]{display:none}
    .stage-player{position:absolute;inset:0;z-index:2;background:#05070c;margin:0;padding:0;border:0}
    .stage-player[hidden]{display:none}
    .stage-player>b{display:none}
    .stage-player .duo-youtube-frame{position:absolute;inset:0}
    .stage-player .duo-youtube-frame iframe{width:100%;height:100%;border:0;display:block}
    .stage-player>p{position:absolute;left:16px;bottom:54px;z-index:3;max-width:calc(100% - 32px);margin:0;padding:6px 12px;border-radius:999px;background:#0b101ce6;color:#e4e8ef;font-size:11px;pointer-events:none}
    .stage-player>p:empty{display:none}
    .stage-player>button{position:absolute;z-index:4;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;min-height:48px;padding:0 24px;border-radius:999px;border:0;background:var(--coral);color:#2b1519;font-weight:800}
    .stage-player>button[hidden]{display:none}
    .stage-empty{position:absolute;inset:0;z-index:1;display:grid;place-content:center;justify-items:center;gap:12px;padding:56px 7% 28px;text-align:center;background-size:cover;background-position:center}
    .stage-empty[hidden]{display:none}
    .stage-empty h4{font-size:clamp(22px,3.1vw,38px);letter-spacing:-.05em;line-height:1.1;max-width:26ch}
    .stage-empty p{max-width:46ch;color:#d3d9e4;font-size:13px}
    .stage-empty .rb{margin-top:6px;min-height:44px;padding-inline:22px;font-size:13px}
    .stage-bar{display:flex;align-items:center;gap:14px;padding:16px 20px;border-top:1px solid var(--line);background:#121926;min-height:78px;min-width:0}
    .stage-bar .rb-main{min-width:132px;min-height:46px}
    .stage-bar .clock{color:#cfd6e2;font-size:12px;font-variant-numeric:tabular-nums;min-width:42px}
    .stage-bar .clock:last-of-type{text-align:right}
    .stage-bar .bar-text{flex:1;color:#cfd6e2;font-size:13px;min-width:0}
    .stage-seek{flex:1;min-width:80px;padding:0!important;height:20px;border:0!important;background:transparent!important;accent-color:var(--coral);cursor:pointer}
    .stage-seek:disabled{opacity:.45;cursor:not-allowed}
    .stage-after{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:20px 24px;border:1px solid var(--line);border-radius:22px;background:var(--s1)}
    .stage-after h4{font-size:15px}.stage-after p{margin-top:4px}

    /* painel lateral */
    .rv3-side{display:grid;gap:16px;min-width:0}
    .rv3-side h4{font-size:19px;letter-spacing:-.03em}
    .people-card{padding:16px;border:1px solid var(--line);border-radius:20px;background:var(--s1);display:grid;gap:12px}
    .people-top{display:flex;align-items:center;gap:12px}
    .avatars{display:flex}.avatar{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-size:13px;font-weight:900;color:#2b1925;background:var(--coral);border:2px solid var(--s1);position:relative}
    .avatar+.avatar{margin-left:-9px;background:#ee94b3}.avatar.is-away{filter:saturate(.2) brightness(.8)}
    .people-names b{display:block;font-size:13px}.people-names small{color:var(--mute);font-size:11px}
    .online-voice{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .online-voice .voice-state{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;background:#242c3b;color:#cdd5e1;font-size:11px;font-weight:800}
    .online-voice .voice-state.is-on{background:#1d3a31;color:var(--green)}
    .online-voice .voice-state.is-warn{background:#40302a;color:#ffd1aa}
    .online-voice .voice-note{flex-basis:100%;color:var(--mute);font-size:11px}
    .avatar.is-speaking{box-shadow:0 0 0 2px #A6E4C6,0 0 16px #A6E4C6aa;animation:duoSpeak 1.1s ease-in-out infinite}
    @keyframes duoSpeak{50%{box-shadow:0 0 0 3px #A6E4C6,0 0 24px #A6E4C6}}@media (prefers-reduced-motion:reduce){.avatar.is-speaking{animation:none}}
    .voice-sub{margin:6px 0 0;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#FFAC8F}.voice-check{display:flex;gap:8px;align-items:center;font-size:12px;color:#d6dbe6;cursor:pointer;margin:0}
    .voice-check input{width:auto;accent-color:#FFAC8F}.voice-device input[type=range]{width:100%;padding:0;border:0;background:transparent;accent-color:#FFAC8F}
    .voice-devices{margin-top:10px;display:grid;gap:10px;padding-top:10px;border-top:1px solid var(--line)}.voice-devices p{margin:0}
    .voice-device label{display:block;margin:0 0 4px;font-size:11px;color:#d6dbe6}
    .voice-device select{width:100%;background:#0b101c;color:#fff;border:1px solid var(--line);border-radius:12px;padding:8px 10px;font:inherit;font-size:12px}
    .online-voice .voice-error{color:#ffd1aa;font-size:12px;line-height:1.5}
    .online-voice .rb{min-height:34px;padding:6px 13px}
    .online-voice .vol{display:inline-flex;align-items:center;gap:7px;color:var(--mute);font-size:11px}
    .online-voice .vol label{margin:0}.online-voice input[type=range]{width:84px;padding:0;border:0;background:transparent;accent-color:var(--coral)}
    .rv3-kicker{color:#7f899b;font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
    .rv3-tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border-radius:999px;background:#0e1420;border:1px solid #222b3a}
    .rv3-tabs button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;border:0;border-radius:999px;background:transparent;color:#a3acbb;font-size:12px;font-weight:800;transition:background .22s,color .22s,transform var(--ease)}
    .rv3-tabs button:hover{color:#fff}.rv3-tabs button:active{transform:scale(.97)}
    .rv3-tabs button[aria-selected=true]{background:var(--s2);color:#fff;box-shadow:0 2px 10px #0005}
    .rv3-tabs .pill{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--coral);color:#2b1519;font-size:10px;display:inline-grid;place-items:center}
    .online-room .rv3-ctx-toggle{display:none}
    .rv3-ctx-wrap{display:grid;grid-template-rows:1fr}
    .rv3-ctx-inner{min-height:0;min-width:0;display:grid;gap:14px;align-content:start}
    .rv3-tabpanel{display:grid;gap:14px;min-width:0}
    .rv3-tabpanel.is-swap{animation:rv3Swap .22s both}
    @keyframes rv3Swap{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    .rv3-tabpanel h4{font-size:21px}
    .searchbar{display:flex;gap:8px}
    .searchbar input{flex:1;min-width:0}
    .link-row{display:grid;gap:8px}
    .link-row[hidden]{display:none}
    .results{display:grid;gap:8px;max-height:340px;overflow:auto}
    .item{display:flex;gap:12px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:16px;background:var(--s1);transition:border-color var(--ease),background var(--ease),transform var(--ease)}
    .item:hover{border-color:#566377;background:var(--s2)}
    .item .thumb{width:64px;height:48px;flex:none;border-radius:10px;background:#3a4558 center/cover;display:grid;place-items:center;color:var(--coral);font-size:14px}
    .item .thumb.poster{width:44px;height:62px}
    .item-copy{min-width:0;flex:1}.item-copy b{display:block;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .item-copy small{display:block;color:var(--mute);font-size:11px;margin-top:3px}
    .item .rb{min-height:32px;padding:5px 12px;font-size:11px}
    .pick{display:grid;grid-template-columns:62px minmax(0,1fr);gap:12px;padding:10px;border:1px solid var(--line);border-radius:18px;background:var(--s1);transition:border-color var(--ease),opacity .22s,transform var(--ease)}
    .pick:hover{border-color:#566377}
    .pick.is-match{border-color:var(--green);background:#16282a}.pick.is-dim{opacity:.55}
    .pick-num{border-radius:12px;background:#465468 center/cover;display:grid;place-items:center;font-size:20px;font-weight:900;color:#fff;text-shadow:0 2px 10px #000b;min-height:84px}
    .pick-body{min-width:0;display:grid;gap:6px;align-content:start}
    .pick-body b{font-size:13px}.pick-body small{color:var(--mute);font-size:11px}
    .pick-votes{display:flex;gap:6px;flex-wrap:wrap}
    .vchip{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:999px;background:#242c3b;color:#cdd5e1;font-size:10px;font-weight:800}
    .vchip.yes{background:#1d3a31;color:var(--green)}.vchip.no{background:#3a2430;color:#ffb4c4}
    .pick-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .pick-actions .rb{min-height:32px;padding:5px 12px;font-size:11px}
    .pick-actions .rb[aria-pressed=true]{background:#3a2530;border-color:var(--coral);color:var(--coral)}
    .match-banner{padding:16px 18px;border:1px solid var(--green);border-radius:18px;background:#16282a;display:grid;gap:5px}
    .match-banner b{font-size:16px;color:#d6f5e6}.match-banner p{color:#c3d6cf}
    .match-banner.is-fresh{animation:rv3Pop .6s cubic-bezier(.2,1.2,.4,1) both}
    @keyframes rv3Pop{from{transform:scale(.94);opacity:.4}to{transform:none;opacity:1}}
    .note-green{padding:14px 16px;border-radius:18px;background:#14281f;border:1px solid #24493a;display:grid;gap:5px}
    .note-green b{color:var(--green);font-size:10px;letter-spacing:.12em;text-transform:uppercase}.note-green p{color:#c3d6cf}
    .soft{padding:16px;border-radius:18px;border:1px dashed var(--line);display:grid;gap:10px;justify-items:start}
    .rv3-foot{font-size:11px;color:#778195}
    .online-room a.rb{text-decoration:none}
    .nf-confirm{display:flex;gap:8px;align-items:center;margin:0 0 8px;font-size:11px;color:#d6dbe6}.nf-confirm input{width:auto;accent-color:var(--coral)}
    .nf-actions{display:grid;gap:6px;margin-top:6px}
    .item:has(.nf-actions){flex-wrap:wrap}.item .nf-actions{flex-basis:100%}

    /* convite */
    .online-room dialog{width:min(440px,calc(100vw - 32px));padding:24px;border:1px solid var(--line);border-radius:24px;background:var(--s1);color:var(--ink);box-shadow:0 30px 80px #000c}
    .online-room dialog::backdrop{background:#05070cc9;backdrop-filter:blur(5px)}
    .online-room dialog[open]{animation:rv3Swap .22s both}
    .online-room dialog h4{font-size:20px;margin-bottom:8px}
    .online-room dialog .online-row{margin-top:14px}
    .online-room textarea{width:100%;box-sizing:border-box;background:#0b101c;color:#fff;border:1px solid var(--line);border-radius:14px;padding:10px 12px;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;resize:vertical;word-break:break-all}
    .online-room textarea:focus-visible{outline:2px solid var(--coral);outline-offset:2px}
    .short-code{font:800 34px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;text-align:center;padding:16px 10px;margin:12px 0 4px;border:1px dashed var(--coral);border-radius:16px;user-select:all;color:var(--coral)}
    .p2p-manual{margin-top:12px}.p2p-manual summary{cursor:pointer;color:var(--mute);font-size:12px}.p2p-manual summary:hover{color:var(--ink)}
    .p2p-section{margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}.p2p-section h5{margin:0 0 4px;font-size:14px}
    .invite-field{display:flex;gap:8px;margin-top:14px}.invite-field input{flex:1;min-width:0;letter-spacing:.06em}

    /* tela cheia ocupa a sala: sem coluna lateral global */
    body.room-v3-on:has(#view-room:not([hidden])) .shell{grid-template-columns:78px minmax(0,1fr)}
    body.room-v3-on:has(#view-room:not([hidden])) .topbar,body.room-v3-on:has(#view-room:not([hidden])) #view-room>.view-title{display:none}
    body.room-v3-on:has(#view-room:not([hidden])) .sidebar{padding-inline:13px}
    body.room-v3-on:has(#view-room:not([hidden])) .brand{justify-content:center}
    body.room-v3-on:has(#view-room:not([hidden])) :is(.brand-copy,.side-label,.nav .label,.couple-card,.side-footer){display:none}
    body.room-v3-on:has(#view-room:not([hidden])) .nav button{justify-content:center}
    body.room-v3-on:has(#view-room:not([hidden])) .nav .icon{font-size:19px}
    body.room-v3-on:has(#view-room:not([hidden])) main{padding:28px 32px 56px}
    body.room-v3-on .online-room{margin:0}

    @media(max-width:1200px){.rv3-grid{grid-template-columns:minmax(0,1fr) 316px;gap:18px}body.room-v3-on:has(#view-room:not([hidden])) main{padding-inline:22px}}
    @media(max-width:900px){
      .rv3-grid{grid-template-columns:minmax(0,1fr)}
      .rv3-side{gap:14px}
      .online-room .rv3-ctx-toggle{display:inline-flex;justify-content:space-between;width:100%}
      .rv3-ctx-toggle .chev{display:inline-block;transition:transform .22s}.rv3-ctx-toggle[aria-expanded=true] .chev{transform:rotate(180deg)}
      .rv3-ctx-wrap{grid-template-rows:0fr;transition:grid-template-rows .22s ease}
      .rv3-ctx-wrap.is-open{grid-template-rows:1fr}
      .rv3-ctx-inner{overflow:hidden;transition:visibility .22s}
      .rv3-ctx-wrap:not(.is-open) .rv3-ctx-inner{visibility:hidden}
    }
    @media(max-width:650px){
      body.room-v3-on:has(#view-room:not([hidden])) main{padding:20px 14px 90px}
      .rv3-head-actions{width:100%;justify-content:flex-end}
      .stage-view{aspect-ratio:16/10}
      .stage-bar{flex-wrap:wrap;gap:10px 12px;padding:14px}
      .stage-bar .rb-main{flex:1 1 100%}.stage-seek{min-width:110px}
      .stage-bar .bar-text{flex-basis:100%}
      .stage-badges{left:12px;right:12px;top:12px}
      .stage-empty{padding:48px 5% 16px}
      .stage-after{padding:16px}
      .online-room .lobby{padding:16px}
    }
    @media(prefers-reduced-motion:no-preference){.rv3-conn.is-off:before{animation:onlinePulse 1.3s ease-in-out infinite}}
    @media(prefers-reduced-motion:reduce){.online-room,.online-room *,.online-room *:before,.online-room *:after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
    @keyframes onlinePulse{50%{opacity:.35;transform:scale(.7)}}
  </style><div class="lobby" id="online-lobby"><h3>Sala online · teste local</h3><p>Crie uma sala para até 4 pessoas ou entre com o convite recebido. O Host aprova cada entrada uma única vez; depois, todos controlam o vídeo.</p><div id="online-content"></div></div>
  <div class="rv3" id="rv3" hidden>
    <header class="rv3-head">
      <div class="rv3-titles"><h3 id="rv3-title">Nossa sala</h3><p id="rv3-sub"></p><span class="rv3-conn" id="rv3-conn" role="status"></span></div>
      <div class="rv3-head-actions">
        <button type="button" class="rb" id="rv3-invite-btn" data-online-act="invite-open" aria-haspopup="dialog">↗ Convidar<i class="rv3-dot" id="rv3-invite-dot" hidden></i></button>
        <div class="rv3-menuwrap"><button type="button" class="rb rb-icon" id="rv3-menu-btn" data-online-act="menu" aria-haspopup="true" aria-expanded="false" aria-controls="rv3-menu" aria-label="Mais opções da sala">•••</button>
        <div class="rv3-menu" id="rv3-menu" role="group" aria-label="Opções da sala" hidden></div></div>
      </div>
    </header>
    <div class="rv3-alert" id="rv3-alert" hidden></div>
    <div class="rv3-chips" id="rv3-chips" role="group" aria-label="Plataforma da sala"></div>
    <div class="rv3-grid" id="rv3-grid">
      <div class="rv3-main">
        <section class="stage" aria-label="Palco do vídeo">
          <div class="stage-view" id="stage-view">
            <span class="light l1" aria-hidden="true"></span><span class="light l2" aria-hidden="true"></span>
            <div class="stage-badges"><span class="stage-badge" id="stage-badge"></span></div>
            <div class="stage-empty" id="stage-empty"></div>
          </div>
          <div class="stage-bar" id="stage-bar" role="group" aria-label="Controles do vídeo"></div>
        </section>
        <div class="stage-after" id="stage-after"></div>
      </div>
      <aside class="rv3-side" aria-label="Sessão, busca e match">
        <h4>Na sessão</h4>
        <div class="people-card"><div class="people-top" id="people-top"></div><div class="online-voice" id="online-voice"></div><div class="voice-devices" id="online-voice-devices" hidden></div></div>
        <span class="rv3-kicker">Fazer juntos</span>
        <button type="button" class="rb rv3-ctx-toggle" id="rv3-ctx-toggle" data-online-act="ctx-toggle" aria-expanded="false" aria-controls="rv3-ctx-wrap"><span id="rv3-ctx-label">Buscar vídeo e match</span><span class="chev" aria-hidden="true">⌄</span></button>
        <div class="rv3-ctx-wrap" id="rv3-ctx-wrap"><div class="rv3-ctx-inner">
          <div class="rv3-tabs" id="rv3-tabs" role="tablist" aria-label="Fazer juntos"></div>
          <div class="rv3-tabpanel" id="rv3-tabpanel" role="tabpanel" tabindex="-1"></div>
        </div></div>
      </aside>
    </div>
    <p class="rv3-foot" id="rv3-foot">A sessão fica nesta aba. Atualizar a página perde o acesso à sala.</p>
  </div>
  <dialog id="rv3-invite-dialog" aria-labelledby="rv3-invite-title"></dialog>
  <p id="online-message" class="online-msg" role="status" aria-live="polite"></p>`;
  roomView.insertBefore(panel, roomView.querySelector('.decision'));
  const $ = (sel) => panel.querySelector(sel);
  const lobby = $('#online-lobby'), content = $('#online-content'), message = $('#online-message'), rv3 = $('#rv3');
  const stageView = $('#stage-view'), stageEmpty = $('#stage-empty'), stageBar = $('#stage-bar'), stageBadge = $('#stage-badge');
  const inviteDialog = $('#rv3-invite-dialog'), menu = $('#rv3-menu'), menuBtn = $('#rv3-menu-btn'), ctxWrap = $('#rv3-ctx-wrap');
  // Nó estável do iframe: fica fora das regiões que são redesenhadas a cada snapshot.
  const playerPanel = document.createElement('section');
  playerPanel.className = 'stage-player'; playerPanel.hidden = true;
  stageView.insertBefore(playerPanel, stageEmpty);
  const youtube = window.DuoYouTubePlayer?.create(playerPanel, {
    onAction: (id, action, seconds) => run(async () => { await client.playback(id, action, seconds); apply(client.snapshot); }),
    onError: (error) => say(error),
  });
  // Ponte Netflix: a credencial da sala fica aqui; a extensão só recebe a visão mínima (título, watchId, play/pause/seek).
  const nfBridge = window.DuoNetflixBridge ? new window.DuoNetflixBridge.NetflixBridge({
    window,
    onChange: () => { if (client && snapshot) { uiVersion++; renderStage(); renderTabs(); renderPanel(); } },
    onEvent: (m, ack) => nfLink.handleEvent(m, ack),
  }) : null;
  let nfLink = null;
  const clock = window.DuoYouTubePlayer?.formatClock || ((v) => String(Math.floor(v || 0)));
  const voice = window.DuoVoice ? new window.DuoVoice.VoiceCall({ onChange: () => renderVoice(), mount: panel, onSpeaking: (s) => onSpeakingChange(s) }) : null;
  if (voice) panel.insertBefore(voice.audio, message);
  let inviteManual = false, selectInvite = false, voiceError = '', voiceDiag = '', voiceDiagTimer = null, voiceDevicesOpen = false, deviceKey = '', lastVoiceState = '';
  // Conexão direta (sem servidor de encontro): ver server/p2p-link.js. Host: oferta pendente e conexões abertas; convidado: resposta a enviar.
  const P2P = window.DuoP2P;
  const seenPending = new Set();
  // ---- voz: configurações (ducking), indicador de quem fala e push-to-talk ----
  const VUI_KEY = 'duotela-voice-ui';
  const loadVui = () => { try { const p = JSON.parse(localStorage.getItem(VUI_KEY) || '{}'); return { duck: p.duck !== false, duckLevel: Number.isFinite(p.duckLevel) ? Math.max(0.05, Math.min(1, p.duckLevel)) : 0.35 }; } catch { return { duck: true, duckLevel: 0.35 }; } };
  const vui = loadVui();
  const saveVui = () => { try { localStorage.setItem(VUI_KEY, JSON.stringify(vui)); } catch { /* sem armazenamento */ } };
  const DK = window.DuoDucking;
  const ducker = DK ? new DK.Ducker({ apply: (g) => { youtube?.duck?.(g); window.duoDesktop?.setDuck?.(g); }, settings: { enabled: vui.duck, level: vui.duckLevel } }) : null;
  let speakingNow = {}, pttCapturing = false, pttFailsafe = null, holdActive = false;
  const codeLabel = (code) => ({ Backquote: 'Crase (acento grave)', Space: 'Espaço', ControlLeft: 'Ctrl esquerdo', ControlRight: 'Ctrl direito', AltLeft: 'Alt esquerdo', AltRight: 'Alt direito', ShiftLeft: 'Shift esquerdo', ShiftRight: 'Shift direito', Tab: 'Tab', CapsLock: 'Caps Lock' }[code] || String(code).replace(/^Key/, '').replace(/^Digit/, ''));
  const tel = window.DuoTelemetry?.shared?.() || null;
  if (tel) tel.getState = () => (voice?.joined && voice.state === 'connected' ? 'call' : client ? 'room' : 'idle');
  let callAt = 0, callFailedReported = false, voiceJoinAt = 0;
  // Por que o pareamento falhou, em quatro categorias fixas (nunca texto livre)
  const failKind = (e) => { const m = String(e?.message || e || ''); return /não respondeu|timeout/i.test(m) ? 'timeout' : /serviço de encontro|Failed to fetch|NetworkError|Load failed|recusou a mensagem/i.test(m) ? 'relay' : /entrar|invite|convite|sala|room/i.test(m) ? 'join' : 'link'; };
  async function reportQuality() {
    try {
      let lossPct = 0, jitterMs = 0, rttMs = NaN, any = false;
      for (const [, p] of voice.peers) {
        if (!p.pc) continue;
        const sum = await window.DuoNerdStats.rtcSummary(p.pc), i = sum.inbound;
        if (!i) continue;
        any = true;
        const total = (i.packets || 0) + (i.lost || 0);
        lossPct = Math.max(lossPct, total ? ((i.lost || 0) * 100) / total : 0);
        jitterMs = Math.max(jitterMs, Number(i.jitterMs) || 0);
        if (Number.isFinite(sum.route?.rttMs)) rttMs = Number.isFinite(rttMs) ? Math.max(rttMs, sum.route.rttMs) : sum.route.rttMs;
      }
      const band = any ? window.DuoTelemetry.qualityBand({ lossPct, jitterMs, rttMs }) : null;
      if (band) tel.event('voice_quality', band);
    } catch { /* sem medição de qualidade */ }
  }
  const worstRoute = (types) => (types.includes('relay') ? 'relay' : types.includes('srflx') ? 'srflx' : types.includes('prflx') ? 'prflx' : types.length ? 'host' : 'none');
  async function reportRoute() {
    try {
      const types = [];
      for (const [, p] of voice.peers) { if (!p.pc) continue; const r = (await window.DuoNerdStats.rtcSummary(p.pc)).route; if (r) types.push(r.local, r.remote); }
      tel.event('route', worstRoute(types.filter(Boolean)));
    } catch { /* sem estatísticas de rota */ }
  }
  // Eventos de uso (só enviados se a pessoa permitiu): início e fim da chamada (em faixa), rota e falha de voz
  function trackCall() {
    if (!tel || !voice) return;
    if (voice.state === 'connected' && voice.joined && !callAt) { callAt = Date.now(); callFailedReported = false; tel.event('call_started'); if (voiceJoinAt) { tel.event('connect_time', window.DuoTelemetry.connectBucket(Date.now() - voiceJoinAt)); voiceJoinAt = 0; }
      setTimeout(() => { if (voice.joined && voice.state === 'connected') void reportRoute(); }, 3000);
      setTimeout(() => { if (voice.joined && voice.state === 'connected') void reportQuality(); }, 20000); }
    if (voice.state === 'failed' && voice.joined && !callFailedReported) { callFailedReported = true; tel.event('voice_failed'); }
    if (!voice.joined && callAt) { tel.event('call_ended', window.DuoTelemetry.durationBucket(Date.now() - callAt)); callAt = 0; }
  }
  const NS = window.DuoNerdStats;
  const stats = NS ? new NS.NerdStats(() => ({
    client, snapshot, voice, youtube, desktop: window.duoDesktop,
    hostLinks, guestLink: guestLinkOpen || guestLink?.link || null, extra: { status },
  })) : null;
  const R = window.DuoRendezvous;            // código curto (serviço de encontro cifrado)
  let shortHost = null, p2pManualOpen = false;
  const relayBase = () => { try { return localStorage.getItem('duotela-relay') || R.DEFAULT_RELAY; } catch { return R.DEFAULT_RELAY; } };
  // No aplicativo cada aparelho tem a própria sala local: o convite curto (123456.…) só vale para quem usa o MESMO servidor.
  const isDesktop = !!window.duoDesktop;
  const friendlyError = (e) => ({
    invalid_invite: 'O convite não confere. Um convite curto (123456.…) só vale para quem usa o mesmo servidor do Host. Peça o convite de conexão direta (começa com DT), ou um convite novo.',
    invite_used: 'Este convite já foi usado. Peça um novo ao Host.',
    invite_expired: 'O convite expirou (vale 15 minutos). Peça um novo ao Host.',
    room_full: 'A sala está cheia.',
  }[e?.code] || null);
  const P2P_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
  let hostLink = null, hostLinks = [], guestLink = null, guestLinkOpen = null, p2pAnswerDraft = '', p2pNote = '';
  let client = null, snapshot = null, invite = '', inviteShown = false, status = 'desconectado', busy = false, shownMatch = null, searchQuery = '', youtubeQuery = '', youtubeLink = '', youtubeResults = [], youtubeSearched = false, linkOpen = false, tab = 'search', ctxOpen = false, closeArmed = false, removeArmed = null, lastNoticeAt = 0, scrubbing = false, recents = [], uiVersion = 0, preferredPlatform = null, autoSelectInFlight = false;
  let desktopNetflixState = null;
  window.duoDesktop?.onNetflixEvent?.((event) => {
    if (!event || !['detected', 'play', 'pause', 'seek', 'status'].includes(event.type)) return;
    desktopNetflixState = event;
    if (client && snapshot?.status === 'active' && snapshot.platform === 'netflix') {
      uiVersion++; renderStage(); renderPanel();
      const media = snapshot.media;
      if (media?.provider === 'netflix' && media.watchId === event.watchId && ['play', 'pause', 'seek'].includes(event.type)) {
        void client.playbackNetflix(media.titleId, media.watchId, event.type, event.positionSec).then(() => apply(client.snapshot), () => say('O controle da Netflix não chegou à sala. Verifique a conexão.'));
      }
    }
  });
  const platforms = { youtube: 'YouTube grátis', netflix: 'Netflix', prime: 'Prime Video', crunchyroll: 'Crunchyroll' };
  const shortPlatform = { youtube: 'YouTube', netflix: 'Netflix', prime: 'Prime Video', crunchyroll: 'Crunchyroll' };
  const ownDefault = () => ({ progress: 0, rating: 0, listed: false });
  const api = window.DuoTelaOnline = {
    get active() { return !!client; },
    get role() { return client?.role || null; },
    get snapshot() { return snapshot; },
    preparePlatform(platform) {
      if (!['youtube', 'netflix'].includes(platform)) return;
      preferredPlatform = platform;
      if (client?.role === 'host' && snapshot?.status === 'active' && snapshot.platform !== platform) {
        void run(async () => { await client.selectPlatform(platform); apply(client.snapshot); });
      } else if (!client) renderLobby();
      else if (client.role !== 'host') say(`${nameFor('host')} escolhe a plataforma desta sala.`);
    },
    getOwn(id) { return snapshot?.viewing?.[client?.role]?.[id] || ownDefault(); },
    async updateProfile(name) {
      if (!client) return false;
      let ok = false;
      await run(async () => { apply(await client.setDisplayName(name)); ok = true; });
      return ok;
    },
    async updateViewing(id, mutate) {
      if (!client || snapshot?.status !== 'active') return;
      const next = { ...api.getOwn(id) };
      mutate(next);
      await run(async () => { await client.setViewing(id, next); apply(client.snapshot); });
    },
    async startRound(mode) {
      if (!client || snapshot?.status !== 'active') return;
      if (client.role !== 'host') { say('Só o Host inicia as três sugestões. Você pode indicar um título manualmente.'); return; }
      await run(async () => { await client.startRound(mode); apply(client.snapshot); });
    },
  };
  const make = (tag, text, attrs = {}) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const button = (text, act, data = {}) => make('button', text, { type: 'button', 'data-online-act': act, ...data, class: data.class ? `rb ${data.class}` : 'rb' });
  const box = () => make('div', undefined, { class: 'online-box' });
  const row = (...nodes) => { const n = make('div', undefined, { class: 'online-row' }); n.append(...nodes); return n; };
  const say = (s) => { message.textContent = s; stats?.log('msg: ' + s); };
  const title = (id) => adapter.title(id);
  const itemFor = (id) => adapter.catalog.find((item) => item.id === id);
  const nameFor = (role) => snapshot?.names?.[role] || (role === client?.role ? adapter.getProfileName() : '') || (role === 'host' ? 'Host' : 'Convidado');
  const members = () => (snapshot?.participants?.length ? snapshot.participants.map((p) => p.id) : ['host', 'guest']);
  const others = () => members().filter((r) => r !== client?.role);
  const joinNames = (ids) => { const n = ids.map(nameFor); return n.length < 2 ? n.join('') : n.slice(0, -1).join(', ') + ' e ' + n[n.length - 1]; };
  const meta = (item) => [item.kind, item.genre !== item.kind ? item.genre : null, Number.isFinite(item.minutes) && item.minutes > 0 ? `${item.minutes} min` : null, Number.isFinite(item.tmdbRating) ? `★ ${item.tmdbRating} TMDB` : null].filter(Boolean).join(' · ');
  const availableTitles = () => adapter.catalog.filter((item) => !snapshot?.platform || window.DuoCatalogSource !== 'tmdb' || item.watchProviders?.includes(platforms[snapshot.platform]));
  const initial = (n) => Array.from(n)[0]?.toLocaleUpperCase('pt-BR') || '?';
  const isActive = () => snapshot?.status === 'active';
  const isYouTube = () => isActive() && snapshot.media?.provider === 'youtube';
  const isNetflix = () => isActive() && snapshot.platform === 'netflix';
  const nfState = () => nfBridge?.state || { detected: false, connected: false, tabs: [], bound: null, status: null, error: null };
  const nfStatusText = { 'autoplay-blocked': 'O navegador pediu um clique: use “Reproduzir aqui” na aba da Netflix.', 'blocked-no-video': 'A aba da Netflix ainda não tem o vídeo carregado.', 'blocked-wrong-watch': 'A aba da Netflix está em outro título.', 'play-failed': 'Não foi possível dar play na aba da Netflix.', 'pause-failed': 'Não foi possível pausar a aba da Netflix.', 'seek-failed': 'Não foi possível mover a posição na aba da Netflix.', 'send-failed': 'Uma ação sua não chegou à sala. Tente de novo.', 'context-changed': 'A sala mudou de título.', applied: 'Em sincronia com a sala.' };
  // Redesenha uma região apenas quando a chave muda; preserva foco/seleção de campos com id.
  const regionKeys = new WeakMap();
  function paint(el, key, build) {
    const k = JSON.stringify(key);
    if (regionKeys.get(el) === k) return false;
    regionKeys.set(el, k);
    const a = document.activeElement;
    const keep = a && a.id && el.contains(a) ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null;
    el.replaceChildren(); build(el);
    if (keep) {
      const n = panel.querySelector(`#${keep.id}`);
      if (n) { n.focus({ preventScroll: true }); try { if (keep.start != null) n.setSelectionRange(keep.start, keep.end); } catch { /* campos sem seleção */ } }
    }
    return true;
  }
  async function run(task) {
    if (busy) return;
    busy = true; panel.setAttribute('aria-busy', 'true');
    try { await task(); } catch (e) { say(friendlyError(e) || (e.code === 'no_titles_on_platform' ? 'O catálogo não tem títulos nesta plataforma. Escolha outra plataforma ou abra um vídeo do YouTube.' : `Não foi possível concluir: ${e.code || e.message || 'erro de rede'}.`)); }
    finally { busy = false; panel.removeAttribute('aria-busy'); }
  }
  function toggleLocal() {
    const onlineMode = location.protocol !== 'file:';
    panel.hidden = !onlineMode;
    roomView.querySelector('.decision').hidden = onlineMode;
    roomView.querySelector('.invite-concept').hidden = onlineMode;
    const demo = roomView.querySelector(':scope > .room-card:last-child');
    if (demo) demo.hidden = onlineMode;
  }
  function trackRecents(s) {
    const m = s?.status === 'active' && s.media?.provider === 'youtube' ? s.media : null;
    if (!m || recents[0]?.videoId === m.videoId) return;
    recents = [{ videoId: m.videoId, title: m.title || 'Vídeo do YouTube' }, ...recents.filter((r) => r.videoId !== m.videoId)].slice(0, 5);
  }
  function apply(s) {
    if (!s) return;
    snapshot = s;
    window.duoDesktop?.setPlatform(s.status === 'active' ? s.platform : null);
    window.duoDesktop?.syncNetflix(s.status === 'active' && s.platform === 'netflix' ? {
      status: s.status, platform: s.platform, code: s.code, you: s.you, revision: s.revision,
      selectedMatch: s.selectedMatch, media: s.media?.provider === 'netflix' ? s.media : null,
      playback: s.media?.provider === 'netflix' ? s.playback : null, serverTime: s.serverTime,
    } : null);
    if (preferredPlatform && client?.role === 'host' && s.status === 'active' && !s.platform && !autoSelectInFlight) {
      autoSelectInFlight = true;
      void client.selectPlatform(preferredPlatform).then(() => apply(client.snapshot), (error) => {
        say(`Não foi possível selecionar ${shortPlatform[preferredPlatform]}: ${error.code || error.message || 'erro de rede'}.`);
        preferredPlatform = null;
      }).finally(() => { autoSelectInFlight = false; });
    }
    nfBridge?.pushSnapshot(s);
    if (s.inviteState && s.inviteState !== 'valid') { invite = ''; inviteShown = false; inviteManual = false; }
    trackRecents(s);
    if (s.notice && s.notice.at !== lastNoticeAt) { if (lastNoticeAt && s.notice.kind === 'round_restarted') say(`${s.notice.name} ${s.notice.reason === 'joined' ? 'entrou' : s.notice.reason === 'removed' ? 'foi removido(a)' : 'saiu'}: a rodada foi reiniciada e todos votam de novo.`); lastNoticeAt = s.notice.at; }
    adapter.setSnapshot(s);
    render();
    youtube?.update(s);
    voice?.update(s);
    renderVoice(); updateBar();
  }
  function connect() {
    if (nfBridge) { nfLink = window.DuoNetflixBridge.createRoomLink({ client, bridge: nfBridge, onApply: apply }); nfBridge.start(); nfBridge.setRoom({ code: client.code, you: client.role }); }
    client.start({ onSnapshot: apply, onStatus: (s, detail) => {
      stats?.log('sala: ' + s + (detail ? ' (' + detail + ')' : ''));
      if (status === s && s !== 'ended') return;
      if (s === 'ended') { disconnect(); say(`Sala encerrada: ${detail}.`); return; }
      status = s;
      render();
    } });
  }
  function disconnect() {
    window.duoDesktop?.setPlatform(null);
    window.duoDesktop?.syncNetflix(null);
    desktopNetflixState = null;
    voice?.closeLocal(); voice?.attach(null);
    nfBridge?.stop();
    closeP2P();
    ducker?.reset(); speakingNow = {}; pttDown(false);
    client?.stop(); client = null; snapshot = null; invite = ''; inviteShown = false; inviteManual = false; status = 'desconectado';
    shownMatch = null; searchQuery = ''; youtubeQuery = ''; youtubeLink = ''; youtubeResults = []; youtubeSearched = false; recents = []; linkOpen = false; tab = 'search'; ctxOpen = false; closeArmed = false; preferredPlatform = null; autoSelectInFlight = false;
    if (inviteDialog.open) inviteDialog.close();
    setMenu(false);
    adapter.leave(); render(); youtube?.update(null);
  }

  /* ---------- renderização ---------- */
  function render() {
    toggleLocal();
    const onlineMode = location.protocol !== 'file:';
    document.body.classList.toggle('room-v3-on', onlineMode && !!client);
    roomView.querySelector(':scope > .view-intro').hidden = onlineMode;
    document.querySelector('#view-list > .view-title').textContent = client ? 'Lista da sala' : 'Minha lista';
    document.querySelector('#view-list > .view-intro').textContent = client ? 'Títulos salvos pelas pessoas desta sala.' : 'Os títulos que você salvou neste navegador.';
    document.querySelector('#view-history > .view-title').textContent = client ? 'Histórico da sala' : 'Meu histórico';
    document.querySelector('#view-history > .view-intro').textContent = client ? 'Progresso compartilhado pelas pessoas desta sala.' : 'Seu progresso salvo neste navegador.';
    document.querySelector('.detail-body > p:last-child').textContent = client ? 'Na sala, você edita apenas sua avaliação; as demais são somente leitura.' : 'As avaliações das duas pessoas são registradas manualmente neste navegador nesta prévia.';
    const ratingLabels = document.querySelectorAll('.detail-controls label');
    if (ratingLabels.length >= 2) { ratingLabels[0].firstChild.textContent = client ? `${nameFor('host')} · Host ` : 'Você '; ratingLabels[1].firstChild.textContent = client ? `${nameFor('guest')} · Convidado ` : 'Seu par '; }
    lobby.hidden = !!client; rv3.hidden = !client;
    if (!client) { renderLobby(); return; }
    renderRoom();
  }
  function renderLobby() {
    content.replaceChildren();
    if (preferredPlatform) content.append(make('p', `Sala para ${shortPlatform[preferredPlatform]} · crie como Host ou entre com um convite. A plataforma será ativada quando a sala estiver conectada.`, { class: 'online-msg', role: 'status' }));
    const identity = box();
    identity.append(make('label', 'Seu nome na sala', { for: 'online-display-name' }));
    const nameInput = make('input', undefined, { id: 'online-display-name', minlength: '2', maxlength: '32', autocomplete: 'nickname', placeholder: 'Como quer aparecer?' });
    nameInput.value = adapter.getProfileName();
    identity.append(nameInput, make('p', 'Você pode mudar esse nome depois na aba Perfil.'));
    content.append(identity);
    const grid = make('div', undefined, { class: 'online-grid' });
    const a = box(); a.append(make('b', 'Criar como Host'), make('p', 'Crie uma sala para até 4 pessoas e envie um convite de uso único a cada uma.'), row(button('Criar sala', 'create', { class: 'rb-main' })));
    const b = box(); b.append(make('b', 'Entrar como Convidado'), make('p', 'Digite o código que o Host enviou (XXXX-XXXX).'), make('label', 'Convite', { for: 'online-invite-input' }), make('input', undefined, { id: 'online-invite-input', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXXX-XXXX' }), row(button('Pedir entrada', 'join')));
    grid.append(a, b); content.append(grid);
    if (guestLink) content.append(guestLinkBox());
  }
  function closeP2P() {
    if (shortHost) { shortHost.listener.stop(); shortHost.link?.close(); shortHost = null; }
    hostLink?.link.close(); hostLink = null;
    for (const l of hostLinks) l.close();
    hostLinks = [];
    guestLink?.link.close(); guestLink = null;
    guestLinkOpen?.close(); guestLinkOpen = null;
    p2pAnswerDraft = ''; p2pNote = '';
  }
  function guestLinkBox() {
    if (!guestLink.answer) {
      const w = box();
      w.append(make('b', 'Conectando ao Host…'), make('p', guestLink.note || 'Procurando o Host pelo código…', { role: 'status' }), row(button('Cancelar', 'p2p-cancel')));
      return w;
    }
    const b = box();
    b.append(make('b', 'Falta só o Host: envie esta resposta a ele'),
      make('p', 'O Host cola esta resposta no convite dele. Quando a conexão direta abrir, seu pedido de entrada segue sozinho.'),
      make('label', 'Resposta para o Host', { for: 'p2p-answer-out' }));
    const out = make('textarea', undefined, { id: 'p2p-answer-out', readonly: '', rows: '4', spellcheck: 'false', 'aria-label': 'Resposta para o Host' });
    out.value = guestLink.answer;
    b.append(out, row(button('Copiar resposta', 'p2p-copy-answer', { class: 'rb-main' }), button('Cancelar', 'p2p-cancel')), make('p', guestLink.note || 'Aguardando o Host colar a resposta…', { role: 'status' }));
    return b;
  }
  async function p2pCopy(text, field) {
    const result = await copyText(text, { navigator, document, container: field?.closest('dialog') || panel });
    if (result === 'copied') { say('Copiado. Envie só à pessoa desejada: o código funciona como uma senha temporária.'); return; }
    field?.focus(); field?.select();
    say('Não foi possível copiar automaticamente. O código está selecionado: use Ctrl+C (Cmd+C no Mac).');
  }
  // Convidado: aceita a oferta, mostra a resposta e, quando o Host a cola, pede entrada pelo canal direto.
  async function p2pJoin(text, name) {
    if (!P2P) throw new Error('Este navegador não oferece conexão direta.');
    closeP2P();
    const link = new P2P.P2PLink({ onLog: (m) => stats?.log(m), iceServers: P2P_ICE, onState: (st) => { if (guestLink?.link === link && (st === 'failed' || st === 'closed')) { guestLink.note = 'A conexão direta não abriu. Peça um novo convite ao Host.'; if (!client) render(); } } });
    const { answer, extra } = await link.acceptOffer(text);
    const inviteText = typeof extra?.invite === 'string' ? extra.invite : /^\d{6}$/.test(extra?.room || '') ? extra.room + '.' + 'A'.repeat(43) : null;
    if (!inviteText) { link.close(); throw new Error('Este código não identifica uma sala.'); }
    guestLink = { link, answer, note: '' };
    render();
    const copied = await copyText(answer, { navigator, document, container: panel });
    say(copied === 'copied' ? 'Resposta copiada: cole-a na conversa com o Host e aguarde, a entrada segue sozinha.' : 'Copie a resposta abaixo, envie ao Host e aguarde: a entrada segue sozinha.');
    void joinThroughLink(link, inviteText, name);
  }
  // Espera o canal direto abrir e pede entrada na sala do Host por ele.
  async function joinThroughLink(link, inviteText, name, short = false) {
    try {
      await Promise.race([link.opened, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10 * 60 * 1000))]);
      if (guestLink?.link !== link) return;
      const c = new DuoRoomClient({ serviceUrl: location.origin, allowInsecure: isPrivateLanHttp(), fetchImpl: link.fetch });
      await c.joinRoom(inviteText, name);
      if (short) tel?.event('pair_joined');
      client = c; voice?.attach(c); guestLinkOpen = link; guestLink = null;
      apply(await client.getState({ after: 0 })); connect(); say('Pedido enviado. Aguarde a aprovação do Host.');
    } catch (e) {
      if (short) tel?.event('pair_fail', e.message === 'timeout' ? 'link' : 'join');
      if (guestLink?.link === link) { guestLink.note = e.message === 'timeout' ? 'A conexão direta não abriu a tempo. Peça um novo código ao Host.' : (friendlyError(e) || 'Não foi possível entrar: ' + (e.code || e.message || 'erro de rede') + '.'); if (!client) render(); }
      link.close();
    }
  }
  // Convidado com código curto: oferece a conexão, o Host (que escuta o código) responde com a sala, e a entrada segue sozinha.
  async function shortJoin(text, name) {
    if (!P2P || !R) throw new Error('Este navegador não oferece conexão direta.');
    if (!globalThis.crypto?.subtle) throw new Error('Este navegador só libera criptografia em 127.0.0.1, localhost ou https. Use a conexão manual (código grande).');
    closeP2P();
    tel?.event('pair_try');
    const code = R.normalizeCode(text);
    const link = new P2P.P2PLink({ onLog: (m) => stats?.log(m), iceServers: P2P_ICE, onState: (st) => { if (guestLink?.link === link && (st === 'failed' || st === 'closed') && !client) { guestLink.note = 'A conexão direta não abriu. Peça um novo código ao Host.'; render(); } } });
    guestLink = { link, answer: null, note: '' };
    render(); say('Procurando o Host pelo código…');
    void (async () => {
      try {
        const offer = await link.createOffer();
        const { answer, extra } = await R.guestPair({ code, relay: new R.Relay({ baseUrl: relayBase() }), offer });
        if (guestLink?.link !== link) { link.close(); return; }
        guestLink.note = 'Host encontrado. Conectando…'; if (!client) render();
        await link.acceptAnswer(answer);
        if (!/^\d{6}$/.test(extra?.room || '')) throw new Error('A resposta do Host não identifica a sala.');
        await joinThroughLink(link, extra.room + '.' + 'A'.repeat(43), name, true);
      } catch (e) {
        tel?.event('pair_fail', failKind(e));
        if (guestLink?.link === link) { guestLink.note = e.message || 'Não foi possível conectar.'; if (!client) render(); }
        link.close();
      }
    })();
  }
  async function ensureInvite() {
    if (invite) return;
    const d = await client.newInvite();
    invite = d.invite; inviteShown = false; inviteManual = false;
  }
  // O segredo do convite nunca viaja no código: quem pedir entrada por ESTE canal usa o convite do código (uso único, 15 min),
  // e o Host continua aprovando cada entrada.
  function serveWithInvite(link, room, secret) {
    const local = P2P.P2PLink.localHandler(window.fetch.bind(window), location.origin);
    link.serve((req) => {
      if (req.method === 'POST' && req.path === '/v1/rooms/' + room + '/join') {
        try { req = { ...req, body: JSON.stringify({ ...JSON.parse(req.body), inviteSecret: secret }) }; } catch { /* corpo inválido: o serviço recusa */ }
      }
      return local(req);
    });
  }
  function stopShortHost() { if (shortHost) { shortHost.listener.stop(); shortHost.link?.close(); shortHost = null; } }
  // Host: gera um código curto (uso único, 15 min) e fica escutando; o convidado digita o código e a conexão abre sozinha.
  async function shortOffer() {
    if (!R || !P2P) return;
    stopShortHost();
    await ensureInvite();
    let ice = P2P_ICE;
    try { const list = await client.iceServers(); if (list.length) ice = list; } catch { /* usa o STUN padrão */ }
    const code = R.newCode(), room = client.code, secret = invite.split('.')[1];
    tel?.event('pair_code');
    const state = { code, note: 'Aguardando o convidado digitar o código…', listener: null, link: null };
    const refresh = () => { if (inviteDialog.open) buildInviteDialog(); };
    state.listener = R.hostListen({ code, relay: new R.Relay({ baseUrl: relayBase() }), respond: async (offerCode) => {
      state.note = 'Convidado encontrado. Conectando…'; refresh(); tel?.event('pair_found');
      const link = new P2P.P2PLink({ onLog: (m) => stats?.log(m), iceServers: ice, onState: (st) => {
        if (st === 'open') { hostLinks.push(link); state.note = 'Conexão aberta. Aprove o pedido de entrada quando ele chegar.'; tel?.event('pair_open'); }
        else if ((st === 'failed' || st === 'closed') && shortHost === state && !hostLinks.includes(link)) state.note = 'A conexão não abriu. Gere um novo código.';
        refresh();
      } });
      serveWithInvite(link, room, secret);
      state.link = link;
      const { answer } = await link.acceptOffer(offerCode, { room });
      return { answer, extra: { room } };
    } });
    shortHost = state;
    state.listener.result.then(() => { if (shortHost === state && !state.note.startsWith('Conexão aberta')) { state.note = 'Código usado. Abrindo a conexão…'; refresh(); } },
      (e) => { if (shortHost === state) { state.note = e.message || 'Não foi possível usar o serviço de encontro.'; refresh(); } });
    buildInviteDialog();
    const copied = await copyText(code, { navigator, document, container: inviteDialog });
    say(copied === 'copied' ? 'Código copiado. Envie ao convidado.' : 'Código gerado: ' + code);
  }
  async function p2pConnect() {
    if (!hostLink) return;
    try { await hostLink.link.acceptAnswer(p2pAnswerDraft); p2pNote = 'Conectando… em instantes o pedido de entrada aparece para você aprovar.'; p2pAnswerDraft = ''; }
    catch (e) { p2pNote = e.message || 'Resposta inválida.'; }
    buildInviteDialog();
  }
  // Host: gera o convite de conexão direta (oferta + convite da sala) e depois aceita a resposta do convidado.
  async function p2pOffer() {
    if (!P2P) return;
    await ensureInvite();
    hostLink?.link.close(); hostLink = null; p2pAnswerDraft = ''; p2pNote = '';
    let ice = P2P_ICE;
    try { const list = await client.iceServers(); if (list.length) ice = list; } catch { /* usa o STUN padrão */ }
    const link = new P2P.P2PLink({ onLog: (m) => stats?.log(m), iceServers: ice, onState: (st) => {
      if (st === 'open') { hostLinks.push(link); if (hostLink?.link === link) hostLink = null; p2pNote = 'Conexão direta aberta. Aprove o pedido de entrada quando ele chegar.'; }
      else if ((st === 'failed' || st === 'closed') && hostLink?.link === link) { hostLink = null; p2pNote = 'A conexão direta não abriu. Gere um novo convite.'; }
      if (inviteDialog.open) buildInviteDialog();
    } });
    // O código de conexão leva só o número da sala. O segredo do convite nunca viaja nele: quem pedir entrada por ESTE canal
    // usa o convite deste código (uso único, 15 min), e o Host continua aprovando cada entrada.
    serveWithInvite(link, client.code, invite.split('.')[1]);
    hostLink = { link, code: await link.createOffer({ room: client.code }) };
    buildInviteDialog();
    // O clique em "Gerar" é o gesto do usuário: tenta copiar já. Se o navegador recusar, o campo fica selecionado para Ctrl+C.
    const out = inviteDialog.querySelector('#p2p-offer-out');
    const copied = await copyText(hostLink.code, { navigator, document, container: inviteDialog });
    if (copied === 'copied') say('Código copiado. Cole-o numa conversa com o convidado.');
    else { out?.focus(); out?.select(); say('Código gerado e selecionado: use Ctrl+C e cole-o numa conversa com o convidado.'); }
  }
  function phaseText() {
    const s = snapshot?.status;
    if (s === 'active') return snapshot.media ? 'Vocês estão assistindo juntos' : snapshot.selectedMatch ? 'Uma escolha para a sala' : 'Escolham a próxima história';
    if (s === 'pending_approval') return client.role === 'host' ? `${snapshot.pendingGuest?.displayName || 'Alguém'} quer entrar` : 'Aguardando aprovação do Host';
    if (s === 'guest_left') return 'Você saiu desta sala';
    if (s === 'waiting_guest') return 'Esperando o convidado';
    if (s === 'guest_denied') return 'O Host negou a entrada';
    if (s === 'guest_removed') return 'Você saiu desta sala';
    return 'Preparando a sala';
  }
  function setMenu(open) {
    menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open));
    if (!open) { closeArmed = false; removeArmed = null; }
  }
  function buildMenu() {
    menu.replaceChildren();
    if (client.role === 'host') {
      for (const id of members().filter((r) => r !== 'host')) {
        const armed = removeArmed === id;
        menu.append(button(armed ? `Confirmar: remover ${nameFor(id)}` : `Remover ${nameFor(id)}`, 'remove', { 'data-id': id, class: 'rb-danger' }));
      }
      if (removeArmed) menu.append(make('p', 'A rodada será reiniciada e a pessoa perde o acesso. Clique de novo para confirmar.'));
      menu.append(button(closeArmed ? 'Confirmar: fechar para todos' : 'Fechar sala para todos', 'close', { class: 'rb-danger' }));
      if (closeArmed) menu.append(make('p', 'Isso encerra a sessão de todos. Clique de novo para confirmar.'));
    } else menu.append(button('Sair da sala', 'leave', { class: 'rb-danger' }));
  }
  function renderRoom() {
    const s = snapshot, role = client.role, act = isActive();
    $('#rv3-sub').textContent = `Sala ${client.code} · ${phaseText()}`;
    const net = status === 'connected' ? 'Conectado' : status === 'reconnecting' ? 'Reconectando…' : status === 'ended' ? 'Encerrado' : 'Conectando…';
    const conn = $('#rv3-conn'); conn.textContent = net; conn.classList.toggle('is-off', status !== 'connected');
    const pending = role === 'host' && (s?.pendingGuests?.length > 0);
    const inviteBtn = $('#rv3-invite-btn');
    inviteBtn.hidden = role !== 'host';
    $('#rv3-invite-dot').hidden = !pending;
    inviteBtn.setAttribute('aria-label', pending ? 'Convidar (há uma entrada para aprovar)' : 'Convidar');
    if (!menu.hidden) buildMenu();
    if (inviteDialog.open) buildInviteDialog();
    renderAlert();
    $('#rv3-grid').hidden = !act; $('#rv3-chips').hidden = !act;
    if (!act) return;
    if (s.selectedMatch && shownMatch !== s.selectedMatch) { shownMatch = s.selectedMatch; uiVersion++; }
    renderChips(); renderPeople(); renderStage(); renderAfter(); renderTabs(); renderPanel();
  }
  const capacityOf = () => snapshot?.capacity || 2;
  const hasRoom = () => (snapshot?.participants?.length || 1) + (snapshot?.pendingGuests?.length || 0) < capacityOf();
  function renderAlert() {
    const el = $('#rv3-alert'), s = snapshot, role = client.role;
    const state = s?.status;
    const pendings = role === 'host' ? (s?.pendingGuests || []) : [];
    if (pendings.some((p) => !seenPending.has(p.id + p.requestedAt))) {
      for (const p of pendings) seenPending.add(p.id + p.requestedAt);
      if (inviteDialog.open) inviteDialog.close();
    }
    if (!s || (state === 'active' && !pendings.length)) { el.hidden = true; regionKeys.delete(el); return; }
    el.hidden = false;
    el.classList.toggle('is-attn', pendings.length > 0);
    paint(el, [state, role, !!invite, isDesktop, pendings.map((p) => p.id + p.displayName), s.inviteState, hasRoom()], () => {
      if (pendings.length) {
        el.append(make('h4', pendings.length === 1 ? `${pendings[0].displayName} quer entrar na sala` : `${pendings.length} pessoas querem entrar`), make('p', 'Confirme que foi você quem enviou cada convite; o nome exibido pode ser escolhido por qualquer pessoa. Esta é a única aprovação: depois de entrar, a pessoa não precisa de novas.'));
        for (const p of pendings) el.append(row(button(`Aprovar ${p.displayName}`, 'approve', { 'data-id': p.id, class: 'rb-main' }), button('Negar entrada', 'deny', { 'data-id': p.id })));
      } else if (role === 'host' && state === 'waiting_guest') {
        el.append(make('h4', 'Esperando o convidado'), make('p', isDesktop && P2P ? 'Clique em Convidar para gerar um código curto e enviá-lo só à pessoa desejada.' : invite ? 'O convite está pronto. Use Convidar para copiá-lo e enviá-lo só à pessoa desejada.' : s.inviteState === 'used' ? 'O convite anterior já foi usado.' : s.inviteState === 'expired' ? 'O convite anterior expirou.' : 'Gere um convite de uso único para a outra pessoa.'),
          row(isDesktop && P2P ? button('Convidar', 'invite-open', { class: 'rb-main' }) : button(invite ? 'Copiar convite' : 'Gerar novo convite', invite ? 'copy' : 'invite', { class: 'rb-main' })));
      } else if (role !== 'host' && state === 'pending_approval') {
        el.append(make('h4', 'Aguardando aprovação do Host'), make('p', 'Assim que o Host aprovar, você entra na sala.'));
      } else el.append(make('h4', phaseText()), make('p', 'Você pode sair desta aba pelo menu da sala.'));
    });
  }
  function renderChips() {
    paint($('#rv3-chips'), [snapshot.platform, client.role], (el) => {
      for (const [key, label] of Object.entries(shortPlatform)) {
        const chip = button(key === 'youtube' ? `▶ ${label}` : label, 'platform', { 'data-platform': key, 'aria-pressed': String(snapshot.platform === key), id: `rv3-chip-${key}` });
        if (client.role !== 'host') { chip.disabled = true; chip.title = `${nameFor('host')} escolhe a plataforma`; }
        el.append(chip);
      }
      el.append(make('span', !snapshot.platform ? (client.role === 'host' ? 'Escolha uma plataforma para começar' : `${nameFor('host')} escolhe a plataforma`) : snapshot.platform === 'youtube' ? 'YouTube pronto · demais serviços: catálogo' : (snapshot.platform === 'netflix' ? (window.duoDesktop ? 'Netflix nesta janela · controle conjunto em desenvolvimento' : 'Netflix: match e sincronização experimental (Chrome/Edge com a extensão de teste)') : `${shortPlatform[snapshot.platform]}: catálogo e match; reprodução integrada indisponível`), { class: 'rv3-hint' }));
    });
  }
  const AVATAR_TONES = ['#FFAC8F', '#EE94B3', '#A6E4C6', '#9DB8F5'];
  function renderPeople() {
    const s = snapshot, ids = members();
    const here = ids.filter((r) => s.presence?.[r] !== false).length;
    paint($('#people-top'), [ids.map((r) => nameFor(r) + (s.presence?.[r] === false ? '!' : '')), here, capacityOf()], (el) => {
      const av = make('div', undefined, { class: 'avatars', 'aria-hidden': 'true' });
      ids.forEach((r, i) => { const a = make('span', initial(nameFor(r)), { class: 'avatar' + (s.presence?.[r] === false ? ' is-away' : ''), 'data-role': r }); a.style.background = AVATAR_TONES[i % AVATAR_TONES.length]; av.append(a); });
      const names = make('div', undefined, { class: 'people-names' });
      const away = ids.filter((r) => s.presence?.[r] === false);
      names.append(make('b', ids.map(nameFor).join(' + ')), make('small', `${here} ${here === 1 ? 'pessoa presente' : 'pessoas presentes'} · ${ids.length} na sala (até ${capacityOf()})${away.length ? ` · sem sinal: ${away.map(nameFor).join(', ')}` : ''}`));
      el.append(av, names);
    });
    applySpeaking();
  }
  function renderStage() {
    const s = snapshot, m = s.media, yt = isYouTube(), platform = s.platform, desktopNetflix = platform === 'netflix' && !!window.duoDesktop;
    stageBadge.hidden = yt; stageBadge.textContent = platform ? `▶ ${shortPlatform[platform]}` : '▶ Sala';
    stageEmpty.hidden = yt;
    paint(stageEmpty, [yt, s.selectedMatch, s.round?.roundNumber, !!s.round, platform, client.role, nameFor('host'), s.media?.watchId], (el) => {
      el.style.backgroundImage = '';
      if (yt) return;
      const matched = s.selectedMatch ? itemFor(s.selectedMatch) : null;
      if (!platform) {
        el.append(make('h4', 'Onde vamos assistir?'), make('p', client.role === 'host' ? 'Escolha uma plataforma acima para começar.' : `${nameFor('host')} escolhe a plataforma da sala.`));
      } else if (matched) {
        el.style.backgroundImage = `linear-gradient(90deg,#0b1220f0,#0b122099),url('${matched.image}')`;
        el.append(make('h4', `✦ É um match! ${matched.title}`), make('p', platform === 'youtube' ? 'Agora qualquer pessoa pode escolher o vídeo exato do YouTube.' : desktopNetflix ? (s.media ? 'O título foi associado. Cada pessoa usa sua própria Netflix nesta janela; play e pausa seguem a sala.' : 'Abra o título na Netflix desta janela e associe uma vez para a sala.') : platform === 'netflix' ? (s.media ? 'Título associado. Cada pessoa assiste na própria aba da Netflix; o Dalari Cine sincroniza play, pause e posição.' : 'Cada pessoa assiste na própria conta da Netflix. Abra o título lá e associe a aba à sala.') : 'Vocês escolheram o título. A reprodução integrada nesta plataforma ainda não está disponível.'));
        if (platform === 'youtube') el.append(button('Buscar vídeo →', 'tab-search', { class: 'rb-main' }));
        if (platform === 'netflix') {
          const watchUrl = s.media && window.DuoNetflixBridge?.netflixWatchUrl(s.media.watchId);
          el.append(desktopNetflix
            ? button('Ver Netflix na sala →', 'tab-search', { class: 'rb-main' })
            : watchUrl
            ? make('a', 'Abrir na Netflix →', { href: watchUrl, target: '_blank', rel: 'noopener noreferrer', class: 'rb rb-main' })
            : button('Configurar Netflix →', 'tab-search', { class: 'rb-main' }));
        }
      } else {
        el.append(make('h4', 'A próxima escolha é de vocês'), make('p', platform === 'youtube' ? 'Votem nas sugestões ao lado ou abram um vídeo do YouTube.' : desktopNetflix ? 'Votem nas sugestões ao lado. Depois do match, abram o título na Netflix nesta janela.' : platform === 'netflix' ? 'Votem nas sugestões ao lado. Depois do match, cada pessoa abre o título na própria Netflix.' : `Votem nas sugestões ao lado. A reprodução integrada de ${shortPlatform[platform]} ainda não está disponível.`));
        if (client.role === 'host' && !s.round) el.append(button('✦ Me surpreenda', 'surprise', { class: 'rb-main' }));
      }
    });
    const nfb = nfState();
    paint(stageBar, [yt, platform, !!s.selectedMatch, platform === 'netflix' ? [!!s.media, s.playback?.state, !!nfb.bound, nfb.status, nfb.detected, desktopNetflixState?.status] : 0], (el) => {
      barRefs = null;
      if (!yt && platform === 'netflix') {
        const status = desktopNetflix ? (!s.selectedMatch ? 'Votem para escolher o título' : !s.media ? 'Abra o título na Netflix e associe uma vez' : desktopNetflixState?.status === 'autoplay-blocked' ? 'Clique em Reproduzir no player para liberar o áudio neste computador' : `Netflix na sala · ${s.playback?.state === 'playing' ? 'tocando' : 'pausado'}`) : !s.selectedMatch ? 'Votem para escolher o título' : !s.media ? 'Abra o título na Netflix e associe a aba' : nfb.bound ? (nfStatusText[nfb.status] || `Aba da Netflix sincronizada · ${s.playback?.state === 'playing' ? 'tocando' : 'pausado'}`) : 'Abra o link da Netflix e sincronize esta aba';
        el.append(make('span', status, { class: 'bar-text', role: 'status' }), button(s.selectedMatch ? 'Ver passos →' : 'Ver match →', s.selectedMatch ? 'tab-search' : 'tab-match', { class: 'rb-accent' }));
        return;
      }
      if (!yt) {
        el.append(make('span', platform ? 'Reprodução desta plataforma ainda indisponível' : 'Escolha uma plataforma para começar', { class: 'bar-text' }), button('Ver match →', 'tab-match', { class: 'rb-accent' }));
        return;
      }
      const toggle = button('▶ Reproduzir', 'youtube-toggle', { class: 'rb-main', 'aria-pressed': 'false' });
      const now = make('span', '--:--', { class: 'clock', 'aria-hidden': 'true' }), end = make('span', '--:--', { class: 'clock', 'aria-hidden': 'true' });
      const seek = make('input', undefined, { type: 'range', min: '0', max: '1000', step: '1', value: '0', class: 'stage-seek', id: 'rv3-seek', 'aria-label': 'Posição do vídeo', disabled: '' });
      const sync = make('span', 'Carregando…', { class: 'stage-sync', role: 'status' }); sync.hidden = true;
      const full = button('⛶', 'fullscreen', { class: 'rb-icon', 'aria-label': 'Tela cheia' });
      el.append(toggle, now, seek, end, sync, full, button('Trocar vídeo', 'tab-search', { class: 'rb-accent' }));
      barRefs = { toggle, now, end, seek, sync };
    });
    updateBar();
  }
  let barRefs = null;
  function updateBar() {
    if (!client || !isYouTube() || !barRefs) return;
    const { toggle, now, end, seek } = barRefs;
    const playing = snapshot.playback?.state === 'playing';
    const blocked = playing && !!youtube?.needsLocalStart?.();
    toggle.textContent = blocked ? '▶ Reproduzir aqui' : playing ? 'Ⅱ Pausar' : '▶ Reproduzir';
    toggle.setAttribute('aria-pressed', String(playing && !blocked));
    toggle.setAttribute('aria-label', blocked ? 'Iniciar vídeo neste navegador' : playing ? 'Pausar para a sala' : 'Reproduzir para a sala');
    const dur = youtube?.duration() || 0, local = youtube?.currentPosition() || 0, wanted = youtube?.syncedPosition() || 0;
    now.textContent = dur ? clock(scrubbing ? Number(seek.value) / 1000 * dur : local) : '--:--';
    end.textContent = dur ? clock(dur) : '--:--';
    seek.disabled = !dur;
    seek.setAttribute('aria-valuetext', dur ? `${clock(local)} de ${clock(dur)}` : 'Carregando');
    if (!scrubbing) seek.value = dur ? String(Math.min(1000, Math.round(local / dur * 1000))) : '0';
    const stageSync = barRefs.sync; stageSync.hidden = false;
    const loading = !dur, drift = Math.abs(local - wanted) > 2.5 && playing;
    stageSync.classList.toggle('is-wait', loading || drift || blocked);
    stageSync.textContent = blocked ? 'Inicie aqui' : loading ? 'Carregando…' : drift ? 'Sincronizando…' : playing ? 'Em sincronia' : 'Pausado para a sala';
  }
  function renderAfter() {
    const s = snapshot;
    paint($('#stage-after'), [!!s.media, !!s.round, !!s.selectedMatch], (el) => {
      const copy = make('div');
      if (s.media) { copy.append(make('h4', 'Depois desse vídeo'), make('p', 'Guardem um título para a próxima sessão.')); el.append(copy, button('Explorar match →', 'tab-match', { class: 'rb-accent' })); }
      else { copy.append(make('h4', s.selectedMatch ? 'Match feito' : 'Decisão em andamento'), make('p', s.selectedMatch ? 'Todos da rodada escolheram o mesmo título.' : 'Cada voto é individual. O match aparece quando todos da rodada escolherem o mesmo título.')); el.append(copy, button('Ver votos →', 'tab-match', { class: 'rb-accent' })); }
    });
  }
  function pendingVotes() {
    const r = snapshot.round;
    return r && !snapshot.selectedMatch && r.votes[client.role] ? r.picks.filter((id) => !r.votes[client.role][id]).length : 0;
  }
  function renderTabs() {
    const wrapOpen = ctxOpen;
    ctxWrap.classList.toggle('is-open', wrapOpen);
    const toggle = $('#rv3-ctx-toggle');
    toggle.setAttribute('aria-expanded', String(wrapOpen));
    const pv = pendingVotes();
    $('#rv3-ctx-label').textContent = wrapOpen ? 'Ocultar busca e match' : pv ? `Buscar vídeo e match (${pv} para votar)` : 'Buscar vídeo e match';
    paint($('#rv3-tabs'), [tab, pv, snapshot.platform], (el) => {
      for (const [id, label] of [['search', snapshot.platform === 'netflix' ? 'Netflix' : 'Buscar vídeo'], ['match', '✦ Match']]) {
        const b = make('button', label, { type: 'button', role: 'tab', id: `rv3-tab-${id}`, 'data-online-act': 'tab', 'data-tab': id, 'aria-selected': String(tab === id), 'aria-controls': 'rv3-tabpanel', tabindex: tab === id ? '0' : '-1' });
        if (id === 'match' && pv) b.append(make('span', String(pv), { class: 'pill', 'aria-label': `${pv} para votar` }));
        el.append(b);
      }
    });
  }
  let lastTab = null;
  function renderPanel() {
    const el = $('#rv3-tabpanel'), s = snapshot;
    el.setAttribute('aria-labelledby', `rv3-tab-${tab}`);
    const key = [tab, s.platform, !!s.youtubeSearchEnabled, s.selectedMatch, s.round, !!s.media, s.media?.videoId, client.role, youtubeResults, youtubeQuery.length > 0, recents, linkOpen, uiVersion, members().map(nameFor), nfState()];
    const changed = paint(el, key, () => { if (tab === 'search') buildSearchPanel(el); else buildMatchPanel(el); });
    if (changed && lastTab !== null && lastTab !== tab && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.classList.remove('is-swap'); void el.offsetWidth; el.classList.add('is-swap'); }
    lastTab = tab;
  }
  function resultItem({ thumb, poster, name, sub, action }) {
    const card = make('div', undefined, { class: 'item' });
    const t = make('span', thumb ? undefined : '▶', { class: 'thumb' + (poster ? ' poster' : ''), 'aria-hidden': 'true' });
    if (thumb) t.style.backgroundImage = `url('${thumb}')`;
    const copy = make('div', undefined, { class: 'item-copy' });
    copy.append(make('b', name, { title: name }), make('small', sub));
    card.append(t, copy, action);
    return card;
  }
  function buildSearchPanel(el) {
    const s = snapshot;
    if (s.platform === 'netflix') { buildNetflixPanel(el); return; }
    el.append(make('h4', s.media ? 'Trocar o vídeo' : s.selectedMatch ? `Vídeo para ${title(s.selectedMatch)}` : 'O que vamos ver?'), make('p', 'Troquem o vídeo sem pedir nova aprovação.'));
    if (s.platform !== 'youtube') {
      const soft = make('div', undefined, { class: 'soft' });
      soft.append(make('p', !s.platform ? 'Escolha uma plataforma acima para liberar a busca.' : `A reprodução integrada de ${shortPlatform[s.platform]} ainda não está disponível. Usem o Match para decidir o título e assistam por lá.`));
      if (s.platform) soft.append(button('Ir para Match →', 'tab-match', { class: 'rb-accent' }));
      el.append(soft); return;
    }
    if (s.youtubeSearchEnabled) {
      const bar = make('div', undefined, { class: 'searchbar' });
      const field = make('input', undefined, { id: 'online-youtube-search', type: 'search', placeholder: 'Buscar vídeo ou canal', autocomplete: 'off', 'aria-label': 'Buscar vídeo no YouTube' });
      field.value = youtubeQuery;
      bar.append(field, button('Buscar', 'youtube-search', { class: 'rb-main' }));
      el.append(bar, make('div', undefined, { class: 'results', id: 'online-youtube-results' }));
      renderYouTubeResults(el.lastChild);
      el.append(button('↗ Colar link do YouTube', 'link-toggle', { 'aria-expanded': String(linkOpen), 'aria-controls': 'rv3-link-row', id: 'rv3-link-btn' }));
    } else el.append(make('p', 'Busca de vídeos por nome indisponível nesta instalação. Cole um link do YouTube.'));
    const link = make('div', undefined, { class: 'link-row', id: 'rv3-link-row' });
    link.hidden = s.youtubeSearchEnabled && !linkOpen;
    const lf = make('input', undefined, { id: 'online-youtube-url', type: 'url', placeholder: 'https://www.youtube.com/watch?v=…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Link do vídeo do YouTube' });
    lf.value = youtubeLink;
    link.append(lf, button('Abrir na sala', 'youtube-open', { class: 'rb-main' }));
    el.append(link);
    if (recents.length) {
      el.append(make('span', 'Recentes na sala', { class: 'rv3-kicker' }));
      const list = make('div', undefined, { class: 'results' });
      for (const r of recents) {
        const current = s.media?.videoId === r.videoId;
        list.append(resultItem({ thumb: `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`, name: r.title, sub: current ? 'Em exibição agora' : 'YouTube · aberto nesta sessão',
          action: current ? make('span', 'No ar', { class: 'vchip yes' }) : button('Abrir', 'youtube-result', { 'data-video-id': r.videoId, 'data-video-title': r.title, 'aria-label': `Abrir ${r.title} na sala` }) }));
      }
      el.append(list);
    }
    el.append(make('p', 'Alguns vídeos não permitem reprodução incorporada.'));
  }
  function buildNetflixPanel(el) {
    const s = snapshot, b = nfState(), matched = s.selectedMatch ? itemFor(s.selectedMatch) : null, bridgeOk = !!nfBridge;
    if (window.duoDesktop) {
      el.append(make('h4', 'Netflix no Dalari Cine'), make('p', 'Cada pessoa usa sua própria conta nesta janela. Áudio, legendas e volume do filme são escolhas individuais. A voz da sala tem seu próprio controle.'));
      if (!matched) { el.append(make('p', 'Votem em um título na aba Match. A Netflix pode ficar aberta enquanto vocês decidem.')); return; }
      el.append(make('p', `Escolha da sala: ${matched.title}.`));
      if (!s.media) {
        el.append(make('p', 'Abra o filme ou episódio exato na Netflix desta janela. Depois, confirme uma vez que é a escolha da sala.'));
        const found = desktopNetflixState?.watchId;
        if (found) {
          const confirm = make('label', undefined, { class: 'nf-confirm' });
          confirm.append(make('input', undefined, { type: 'checkbox', id: 'nf-desktop-confirm' }), document.createTextNode(` Confirmo que /watch/${found} é “${matched.title}”`));
          el.append(confirm, button('Associar à sala', 'nf-desktop-associate', { class: 'rb-main', 'data-watch': found }));
        } else el.append(make('p', 'Aguardando a Netflix abrir um título em /watch/…', { class: 'rv3-hint' }));
      } else {
        el.append(make('p', `Título associado: /watch/${s.media.watchId}. O Dalari Cine abre esse link para os demais e compartilha play, pausa e posição.`));
        if (desktopNetflixState?.status === 'autoplay-blocked') el.append(make('p', 'Clique em Reproduzir no player da Netflix neste computador para liberar o áudio.', { class: 'online-msg', role: 'status' }));
        else if (desktopNetflixState?.status === 'player-failed') el.append(make('p', 'O player não aceitou o controle automático. Use os controles da Netflix e teste novamente.', { class: 'online-msg', role: 'status' }));
        else el.append(make('p', `Sala ${s.playback?.state === 'playing' ? 'reproduzindo' : 'pausada'}. Use os controles do vídeo; a outra pessoa acompanha automaticamente.`));
      }
      return;
    }
    el.append(make('h4', 'Netflix'), make('p', 'Cada pessoa assiste na própria aba da Netflix, com a própria conta. O Dalari Cine sincroniza só o título, play, pause e a posição.'));
    if (!matched) { const soft = make('div', undefined, { class: 'soft' }); soft.append(make('p', 'Primeiro votem: o título só vira match quando todos da rodada escolherem.'), button('Ir para Match →', 'tab-match', { class: 'rb-accent' })); el.append(soft); return; }
    const status = make('div', undefined, { class: 'note-green', role: 'status' });
    status.append(make('b', b.detected ? (b.connected ? '✓ Extensão ligada' : 'Extensão sem resposta') : 'Extensão não detectada'),
      make('p', b.detected ? (b.connected ? 'A extensão Dalari Cine (teste local, Chrome ou Edge) está ativa nesta aba.' : 'A extensão perdeu contato. Recarregue esta aba.') : (bridgeOk ? 'Instale a extensão local de teste (veja extension-bridge/README.md) e recarregue esta aba. Safari ainda não foi testado.' : 'Esta página não carregou a ponte.')));
    el.append(status);
    if (b.error) el.append(make('p', b.error, { class: 'online-msg', role: 'alert' }));
    const watchUrl = s.media ? window.DuoNetflixBridge.netflixWatchUrl(s.media.watchId) : null;
    const candidates = (b.tabs || []).filter((t) => !t.bound || t.mine);
    if (!s.media) {
      el.append(make('p', `1. Na Netflix, abra “${matched.title}” (o filme ou o episódio que vão ver). 2. Volte aqui e associe a aba.`));
      const open = make('a', 'Abrir netflix.com', { href: 'https://www.netflix.com/', target: '_blank', rel: 'noopener noreferrer', class: 'rb rb-accent' });
      el.append(open);
    } else {
      el.append(make('p', `Título associado à sala: /watch/${s.media.watchId}.`));
      el.append(make('a', 'Abrir na Netflix', { href: watchUrl, target: '_blank', rel: 'noopener noreferrer', class: 'rb rb-main', 'aria-label': 'Abrir o título associado na Netflix, em nova aba' }));
      if (b.bound) {
        const ok = make('div', undefined, { class: 'note-green', role: 'status' });
        ok.append(make('b', '✓ Aba sincronizada'), make('p', nfStatusText[b.status] || 'Play, pause e posição seguem a sala. Se o navegador pedir um clique, use “Reproduzir aqui” na aba da Netflix.'));
        el.append(ok, button('Desligar sincronização', 'nf-unsync'));
      }
    }
    if (!b.bound || !s.media) {
      const list = candidates.filter((t) => !s.media || t.watchId !== s.media.watchId || !b.bound);
      if (list.length) el.append(make('span', 'Abas da Netflix abertas neste navegador', { class: 'rv3-kicker' }));
      for (const t of list) {
        const same = s.media && t.watchId === s.media.watchId;
        const card = make('div', undefined, { class: 'item', role: 'group', 'aria-label': `Aba da Netflix /watch/${t.watchId}` });
        const copy = make('div', undefined, { class: 'item-copy' });
        copy.append(make('b', `/watch/${t.watchId}`), make('small', same ? 'É o título da sala' : s.media ? 'Título diferente do da sala' : 'Ainda não associada'));
        card.append(make('span', '▶', { class: 'thumb', 'aria-hidden': 'true' }), copy);
        if (same) card.append(button('Sincronizar esta aba', 'nf-sync', { 'data-tab': String(t.tabId), 'data-watch': t.watchId, class: 'rb-main' }));
        else {
          const label = make('label', undefined, { class: 'nf-confirm' });
          label.append(make('input', undefined, { type: 'checkbox', id: `nf-confirm-${t.tabId}`, 'data-tab': String(t.tabId) }), document.createTextNode(` Confirmo que /watch/${t.watchId} é “${matched.title}”`));
          const go = button(s.media ? 'Atualizar associação' : 'Associar à sala', 'nf-associate', { 'data-tab': String(t.tabId), 'data-watch': t.watchId, class: 'rb-main' });
          const wrap = make('div', undefined, { class: 'nf-actions' }); wrap.append(label, go);
          card.append(wrap);
        }
        el.append(card);
      }
      if (b.detected && !list.length) el.append(make('p', s.media ? 'Abra o link acima: a aba aparece aqui para você sincronizar.' : 'Nenhuma aba /watch/ da Netflix aberta ainda. Abra o título e volte.', { class: 'rv3-hint' }));
    }
    el.append(make('p', 'A Netflix não oferece link direto por título para apps externos; por isso a associação é confirmada por você. A reprodução depende da sua assinatura e do navegador.', { class: 'rv3-foot' }));
  }
  function renderYouTubeResults(target) {
    target.replaceChildren();
    for (const item of youtubeResults) {
      target.append(resultItem({ thumb: item.thumbnail, name: item.title, sub: item.channel, action: button('Abrir', 'youtube-result', { 'data-video-id': item.videoId, 'data-video-title': item.title, 'aria-label': `Abrir ${item.title} na sala` }) }));
    }
    if (!youtubeResults.length && youtubeSearched) target.append(make('p', 'Nenhum vídeo encontrado. Tente outros termos ou cole o link direto.'));
  }
  function voteChip(role, id) {
    const vote = (snapshot.round.votes[role] || {})[id];
    return make('span', `${nameFor(role)} ${vote === 'yes' ? '✓ Quer ver' : vote === 'no' ? '✕ Passou' : '… Aguardando'}`, { class: 'vchip' + (vote === 'yes' ? ' yes' : vote === 'no' ? ' no' : '') });
  }
  function buildMatchPanel(el) {
    const s = snapshot, r = s.round;
    el.append(make('h4', r ? 'Escolham juntos' : 'Escolham a próxima história'));
    if (s.notice && s.notice.kind === 'round_restarted') {
      const why = s.notice.reason === 'joined' ? `${s.notice.name} entrou na sala` : s.notice.reason === 'removed' ? `${s.notice.name} foi removido(a)` : `${s.notice.name} saiu da sala`;
      const note = make('div', undefined, { class: 'note-green', role: 'status' });
      note.append(make('b', 'Rodada reiniciada'), make('p', `${why}. Os votos anteriores não valem mais: todos votam de novo.`));
      el.append(note);
    } else if (s.notice) {
      const note = make('div', undefined, { class: 'note-green', role: 'status' });
      note.append(make('b', s.notice.kind === 'joined_after_match' ? 'Entrou depois do match' : 'Saiu depois do match'), make('p', `${s.notice.name} ${s.notice.kind === 'joined_after_match' ? 'entrou depois da escolha. O título e o vídeo continuam; a pessoa também controla a reprodução.' : 'saiu depois da escolha. O título e o vídeo continuam para quem ficou.'}`));
      el.append(note);
    }
    if (r?.participants && !s.selectedMatch) {
      const away = r.participants.filter((who) => s.presence?.[who] === false);
      if (away.length) el.append(make('p', `Aguardando ${joinNames(away)} (sem sinal agora). O match só acontece quando todos votam; o Host pode remover quem não voltar.`, { class: 'rv3-hint' }));
    }
    if (s.selectedMatch) {
      const matched = itemFor(s.selectedMatch);
      if (matched) {
        const banner = make('div', undefined, { class: 'match-banner is-fresh' });
        banner.append(make('b', `✦ É um match! ${matched.title}`), make('p', `${meta(matched)}. Todos da rodada escolheram este título.`));
        banner.append(make('p', s.platform === 'youtube' ? (s.media ? 'O vídeo escolhido está aberto na sala.' : 'Agora qualquer pessoa pode escolher o vídeo exato do YouTube.') : s.platform === 'netflix' && window.duoDesktop ? 'A Netflix está aberta nesta janela. A associação automática do título e os controles conjuntos serão integrados em seguida.' : s.platform === 'netflix' ? (s.media ? 'O link foi compartilhado; cada pessoa abre e sincroniza sua aba da Netflix.' : 'Abra o título na Netflix e associe uma aba à sala.') : 'A reprodução integrada nesta plataforma será feita em outra etapa.'));
        el.append(banner);
      }
    }
    if (!s.platform) { el.append(make('p', client.role === 'host' ? 'Escolham uma plataforma acima para receber sugestões.' : `${nameFor('host')} escolhe a plataforma antes das sugestões.`)); return; }
    if (client.role === 'host' && !s.media && r?.result.status === 'no-match') el.append(button('Novas sugestões', 'surprise', { class: 'rb-main' }));
    if (r) {
      el.append(make('p', `Rodada ${r.roundNumber} · ${r.summary}`));
      r.picks.forEach((id, i) => {
        const item = itemFor(id); if (!item) return;
        const card = make('article', undefined, { class: 'pick' + (r.result.matchId === id ? ' is-match' : r.result.status === 'match' ? ' is-dim' : ''), 'aria-label': item.title });
        const num = make('div', String(i + 1).padStart(2, '0'), { class: 'pick-num', 'aria-hidden': 'true' });
        num.style.backgroundImage = `linear-gradient(#0006,#0008),url('${item.image}')`;
        const body = make('div', undefined, { class: 'pick-body' });
        const votes = make('div', undefined, { class: 'pick-votes', role: 'group', 'aria-label': `Votos em ${item.title}` });
        for (const who of (r.participants || ['host', 'guest'])) votes.append(voteChip(who, id));
        body.append(make('b', item.title), make('small', meta(item)), votes);
        const actions = make('div', undefined, { class: 'pick-actions' });
        if (r.result.status !== 'match') {
          const mine = (r.votes[client.role] || {})[id];
          actions.append(button('♡ Quero ver', 'yes', { 'data-id': id, 'aria-pressed': String(mine === 'yes') }), button('Passo', 'no', { 'data-id': id, 'aria-pressed': String(mine === 'no') }));
        }
        actions.append(button('Detalhes', 'details', { class: 'rb-link', 'data-id': id }));
        body.append(actions); card.append(num, body); el.append(card);
      });
      if (r.result.status === 'no-match') el.append(make('p', 'Sem match nesta rodada. Conversem e indiquem outro título ou peçam novas sugestões.'));
    } else if (!s.selectedMatch) el.append(make('p', client.role === 'host' ? 'Peça sugestões ou indique um título abaixo.' : 'O Host pode pedir sugestões. Vocês também podem indicar um título abaixo.'));
    if (!s.selectedMatch && !s.media) {
      el.append(make('span', 'Indicar um título', { class: 'rv3-kicker' }));
      const field = make('input', undefined, { id: 'online-room-search', type: 'search', placeholder: 'Filme, série ou anime…', autocomplete: 'off', 'aria-label': 'Buscar no catálogo do Dalari Cine' });
      field.value = searchQuery;
      const results = make('div', undefined, { class: 'results', id: 'online-search-results' });
      el.append(field, results); renderSearchResults();
    }
    const note = make('div', undefined, { class: 'note-green' });
    note.append(make('b', '✓ Votos individuais'), make('p', r?.participants?.length > 2 ? `O título entra na sala quando as ${r.participants.length} pessoas da rodada disserem sim.` : 'O título entra na sala quando houver match entre as pessoas da rodada.'));
    el.append(note);
  }
  // Escolha de microfone e saída de áudio. Só repinta quando a lista ou a seleção mudam (para não fechar o menu aberto).
  async function renderDevices() {
    const el = $('#online-voice-devices');
    if (!el) return;
    el.hidden = !voiceDevicesOpen;
    if (!voiceDevicesOpen || !voice) return;
    const d = await voice.listDevices();
    const key = JSON.stringify([d, voice.inputId, voice.outputId, vui.duck, voice.ptt, pttCapturing, others().map((id) => id + nameFor(id))]);
    if (key === deviceKey) return;
    deviceKey = key;
    el.replaceChildren();
    const field = (id, label, items, current, onPick) => {
      const sel = make('select', undefined, { id, 'aria-label': label });
      sel.append(make('option', 'Padrão do sistema', { value: '' }));
      for (const it of items) sel.append(make('option', it.label, { value: it.id }));
      sel.value = items.some((it) => it.id === current) ? current : '';
      sel.addEventListener('change', () => onPick(sel.value));
      const wrap = make('div', undefined, { class: 'voice-device' });
      wrap.append(make('label', label, { for: id }), sel);
      return wrap;
    };
    const fail = (e) => { voiceError = e.message || 'Não foi possível trocar o dispositivo.'; deviceKey = ''; renderVoice(); };
    el.append(field('voice-input-select', 'Microfone', d.inputs, voice.inputId, (v) => voice.setInput(v).then(() => { deviceKey = ''; renderDevices(); }).catch(fail)));
    if (d.canSelectOutput) el.append(field('voice-output-select', 'Saída de áudio', d.outputs, voice.outputId, (v) => voice.setOutput(v).then(() => { deviceKey = ''; renderDevices(); }).catch(fail)));
    else el.append(make('p', 'Este navegador usa a saída de áudio padrão do sistema.'));
    if (!d.labeled) el.append(make('p', 'Os nomes dos dispositivos aparecem depois que você liga a voz e permite o microfone.'));
    const sub = (t) => make('h6', t, { class: 'voice-sub' });
    // vídeo: ducking
    const check = (id, text, on, onChange) => { const row = make('label', undefined, { class: 'voice-check', for: id }); const box = make('input', undefined, { type: 'checkbox', id }); box.checked = on; box.addEventListener('change', () => onChange(box.checked)); row.append(box, document.createTextNode(text)); return row; };
    const slider = (id, label, value, min, onInput) => { const wrap = make('div', undefined, { class: 'voice-device' }); const input = make('input', undefined, { type: 'range', min: String(min), max: '100', value: String(Math.round(value * 100)), id, 'aria-label': label }); input.addEventListener('input', () => onInput(Number(input.value) / 100)); wrap.append(make('label', label, { for: id }), input); return wrap; };
    el.append(sub('Vídeo'), check('voice-duck', 'Abaixar o vídeo quando alguém fala', vui.duck, (on) => { vui.duck = on; saveVui(); ducker?.setSettings({ enabled: on }); }),
      slider('voice-duck-level', 'Volume do vídeo enquanto falam', vui.duckLevel, 5, (v) => { vui.duckLevel = v; saveVui(); ducker?.setSettings({ level: v }); }));
    // microfone: push-to-talk
    const keyRow = make('div', undefined, { class: 'voice-device' });
    keyRow.append(make('label', 'Tecla para falar'), button(pttCapturing ? 'Aperte a tecla… (Esc cancela)' : codeLabel(voice.ptt.code) + ' · alterar', 'ptt-key'));
    el.append(sub('Microfone'), check('voice-ptt', 'Falar apertando uma tecla (push-to-talk)', voice.ptt.on, (on) => { voice.setPtt(on); syncPttKey(); deviceKey = ''; renderVoice(); }), keyRow,
      make('p', 'Funciona com a janela do Dalari Cine em foco; evite teclas que você usa para digitar. O botão "Segurar para falar" também serve.'));
    // volume por pessoa
    const ids = others();
    if (ids.length) {
      el.append(sub('Volume por pessoa'));
      for (const id of ids) el.append(slider('voice-person-' + id, nameFor(id), voice.peerVolumes.has(id) ? voice.peerVolumes.get(id) : 1, 0, (v) => voice.setPeerVolume(id, v)));
    }
  }
  function onSpeakingChange(s) {
    speakingNow = s || {};
    applySpeaking();
    ducker?.setSpeaking(Object.entries(speakingNow).some(([k, v]) => v && k !== 'local'));   // só quem não é você abaixa o vídeo
  }
  function applySpeaking() {
    const me = client?.role;
    for (const av of document.querySelectorAll('#people-top .avatar[data-role]')) av.classList.toggle('is-speaking', !!(av.dataset.role === me ? speakingNow.local : speakingNow[av.dataset.role]));
  }
  // push-to-talk: tecla (com a janela em foco), botão "Segurar para falar" e, no aplicativo, a tecla também com a Netflix em foco
  const isTyping = (t) => !!t && ((t.tagName === 'INPUT' && !['checkbox', 'range', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  function pttDown(down) {
    if (!voice) return;
    voice.pttPress(down);
    clearTimeout(pttFailsafe);
    if (down) pttFailsafe = setTimeout(() => voice.pttPress(false), 3 * 60 * 1000);   // segurança: tecla "presa" solta sozinha
  }
  function syncPttKey() { window.duoDesktop?.setPttKey?.(voice?.ptt.on ? voice.ptt.code : null); }
  window.addEventListener('keydown', (e) => {
    if (pttCapturing) {
      e.preventDefault(); e.stopPropagation(); pttCapturing = false;
      if (e.code !== 'Escape' && /^[A-Za-z0-9]{1,24}$/.test(e.code)) { voice.setPtt(voice.ptt.on, e.code); syncPttKey(); }
      deviceKey = ''; void renderDevices(); renderVoice(); return;
    }
    if (!voice?.ptt.on || e.code !== voice.ptt.code || e.repeat || isTyping(e.target)) return;
    e.preventDefault(); pttDown(true);
  }, true);
  window.addEventListener('keyup', (e) => { if (voice?.ptt.on && e.code === voice.ptt.code) { e.preventDefault(); pttDown(false); } }, true);
  window.addEventListener('blur', () => pttDown(false));
  window.duoDesktop?.onPtt?.((down) => pttDown(!!down));
  panel.addEventListener('pointerdown', (e) => { if (e.target.closest?.('[data-ptt-hold]')) { holdActive = true; pttDown(true); } });
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { if (holdActive) { holdActive = false; pttDown(false); } });
  syncPttKey();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { deviceKey = ''; void renderDevices(); });
  // ---- estatísticas para nerds: painel oculto (Ctrl+Shift+D, ou 5 cliques seguidos no selo "Conectado") ----
  const nerd = { el: null, body: null, open: false, timer: null, paused: false, text: '', clicks: [] };
  function buildNerd() {
    const style = document.createElement('style');
    style.textContent = '.nerd-panel{position:fixed;left:12px;bottom:12px;z-index:2147483000;width:min(560px,calc(100vw - 24px));max-height:72vh;display:flex;flex-direction:column;background:#04070cf2;color:#bff3d6;border:1px solid #2c3a4d;border-radius:14px;box-shadow:0 20px 60px #000c;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace}'
      + '.nerd-panel[hidden]{display:none}.nerd-head{display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid #1f2a3a;flex-wrap:wrap}.nerd-head b{flex:1 1 auto;color:#fff;font-size:12px}'
      + '.nerd-btn{background:#101826;color:#dfe8f5;border:1px solid #2c3a4d;border-radius:8px;padding:3px 9px;font:inherit;cursor:pointer}.nerd-btn:hover{border-color:#6ee7a8}'
      + '.nerd-body{overflow:auto;padding:8px 10px}.nerd-sec{margin:0 0 10px}.nerd-sec h6{margin:0 0 3px;color:#6ee7a8;font:700 11px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em;text-transform:uppercase}'
      + '.nerd-row{display:grid;grid-template-columns:minmax(130px,38%) 1fr;gap:8px;padding:1px 0}.nerd-row.single{grid-template-columns:1fr}.nerd-row .k{color:#8aa0b8;white-space:pre-wrap;overflow-wrap:anywhere}.nerd-row .v{color:#e6f4ec;word-break:break-word}';
    document.head.append(style);
    const el = document.createElement('aside');
    el.className = 'nerd-panel'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Estatísticas para nerds');
    const head = document.createElement('div'); head.className = 'nerd-head';
    const title = document.createElement('b'); title.textContent = 'Dalari Cine · estatísticas para nerds';
    const mk = (label, act) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'nerd-btn'; b.textContent = label; b.dataset.nerd = act; return b; };
    head.append(title, mk('Copiar relatório', 'copy'), mk('Pausar', 'pause'), mk('Fechar', 'close'));
    const body = document.createElement('div'); body.className = 'nerd-body'; body.setAttribute('aria-live', 'off');
    el.append(head, body);
    el.addEventListener('click', async (e) => {
      const act = e.target.dataset?.nerd; if (!act) return;
      if (act === 'close') return void toggleNerd(false);
      if (act === 'pause') { nerd.paused = !nerd.paused; e.target.textContent = nerd.paused ? 'Retomar' : 'Pausar'; return; }
      if (act === 'copy') {
        const header = 'Dalari Cine · relatório ' + new Date().toISOString() + '\n(sem credenciais, convites, SDP nem endereços IP)\n\n';
        const r = await copyText(header + nerd.text, { navigator, document, container: el });
        e.target.textContent = r === 'copied' ? 'Copiado!' : 'Selecione e copie'; setTimeout(() => { e.target.textContent = 'Copiar relatório'; }, 1800);
        if (r !== 'copied') { const sel = getSelection(); const range = document.createRange(); range.selectNodeContents(body); sel.removeAllRanges(); sel.addRange(range); }
      }
    });
    document.body.append(el);
    nerd.el = el; nerd.body = body;
  }
  async function refreshNerd() {
    if (!stats || !nerd.open || nerd.paused) return;
    let sections;
    try { sections = await stats.collect(); } catch (e) { sections = [{ title: 'Erro ao coletar', rows: [['', String(e && e.message || e)]] }]; }
    nerd.text = NS.NerdStats.toText(sections);
    const frag = document.createDocumentFragment();
    for (const sec of sections) {
      const box = document.createElement('div'); box.className = 'nerd-sec';
      const h = document.createElement('h6'); h.textContent = sec.title; box.append(h);
      for (const [k, v] of sec.rows) {
        const row = document.createElement('div'); row.className = 'nerd-row' + (k ? '' : ' single');
        if (k) { const ks = document.createElement('span'); ks.className = 'k'; ks.textContent = k; row.append(ks); }
        const vs = document.createElement('span'); vs.className = 'v'; vs.textContent = v; row.append(vs);
        box.append(row);
      }
      frag.append(box);
    }
    const top = nerd.body.scrollTop;
    nerd.body.replaceChildren(frag); nerd.body.scrollTop = top;
  }
  function toggleNerd(force) {
    if (!stats) return;
    if (!nerd.el) buildNerd();
    nerd.open = force === undefined ? !nerd.open : force;
    nerd.el.hidden = !nerd.open;
    clearInterval(nerd.timer);
    if (nerd.open) { stats.startFps(); void refreshNerd(); nerd.timer = setInterval(refreshNerd, 1000); stats.log('painel de estatísticas aberto'); }
    else stats.stopFps();
  }
  document.addEventListener('keydown', (e) => {
    if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyD') || (e.altKey && e.shiftKey && e.code === 'KeyN')) { e.preventDefault(); toggleNerd(); }   // Ctrl+Shift+D costuma ser tomado pelo navegador
    else if (e.key === 'Escape' && nerd.open && !inviteDialog.open) toggleNerd(false);
  });
  window.addEventListener('duotela:nerd', () => toggleNerd());
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-duo-open=nerd]')) { toggleNerd(true); return; }
    if (!e.target.closest?.('#rv3-conn')) return;
    const now = Date.now(); nerd.clicks = nerd.clicks.filter((t) => now - t < 3000); nerd.clicks.push(now);
    if (nerd.clicks.length >= 5) { nerd.clicks = []; toggleNerd(); }
  });
  function renderVoice() {
    const target = $('#online-voice');
    if (!client) return;
    void renderDevices();
    if (voice && voice.state !== lastVoiceState) { lastVoiceState = voice.state; stats?.log('voz: ' + voice.state); trackCall(); }
    const otherIds = others();
    const other = joinNames(otherIds) || 'a outra pessoa';
    const peerStates = voice ? voice.peerStates() : {};
    const key = [voice?.state, voice?.joined, voice?.muted, other, !!voice, peerStates, snapshot?.voice?.ready, voiceError, voiceDiag, voiceDevicesOpen, voice?.ptt?.on, voice?.pttHeld, voice?.ptt?.code];
    if (voice?.joined && ['failed', 'reconnecting', 'connecting', 'connected'].includes(voice.state) && !voiceDiagTimer) {
      voiceDiagTimer = setTimeout(async () => { voiceDiagTimer = null; const t = voice.joined ? await voice.diagnostics() : ''; if (t !== voiceDiag) { voiceDiag = t; renderVoice(); } }, 2500);
    }
    paint(target, key, () => {
      if (!voice) { target.append(make('span', 'Voz indisponível neste navegador', { class: 'voice-state is-warn' })); return; }
      const labels = {
        off: 'Microfone desligado.', permission: 'Aguardando permissão do microfone…',
        waiting: otherIds.length && otherIds.every((id) => snapshot?.voice?.ready?.[id]) ? 'Preparando a conexão de voz…' : `Aguardando ${other} ligar a voz.`, connecting: 'Conectando a voz…',
        connected: otherIds.length > 1 ? `Conversando: ${otherIds.filter((id) => peerStates[id] === 'connected').map(nameFor).join(', ') || other}${otherIds.some((id) => peerStates[id] !== 'connected') ? ` · aguardando ${joinNames(otherIds.filter((id) => peerStates[id] !== 'connected'))}` : ''}.` : `Conversando com ${other}.`, reconnecting: 'Conexão de voz instável…',
        failed: 'A voz não conectou. Tente novamente.',
        audio_blocked: 'O navegador bloqueou o áudio. Clique em Ouvir áudio.',
      };
      const on = voice.joined && !voice.muted && ['connected', 'connecting', 'waiting'].includes(voice.state);
      const warn = ['failed', 'audio_blocked', 'reconnecting'].includes(voice.state);
      const badge = make('span', !voice.joined ? '🎙 Voz desligada' : voice.muted ? '🎙 Microfone mudo' : voice.ptt.on ? (voice.pttHeld ? '🎙 Falando' : '🎙 Segure ' + codeLabel(voice.ptt.code) + ' para falar') : '🎙 Voz ligada', { class: 'voice-state' + (on ? ' is-on' : warn ? ' is-warn' : '') });
      target.append(badge);
      if (!voice.joined) {
        const start = button(voice.state === 'permission' ? 'Abrindo…' : 'Ligar voz', 'voice-join', { class: 'rb-accent' });
        start.disabled = voice.state === 'permission'; target.append(start);
      } else {
        target.append(button(voice.muted ? 'Ativar microfone' : 'Silenciar', 'voice-mute'));
        if (voice.ptt.on) target.append(make('button', 'Segurar para falar', { type: 'button', class: 'rb rb-main', 'data-ptt-hold': '', 'aria-pressed': String(voice.pttHeld) }));
        if (voice.state === 'failed') target.append(button('Tentar novamente', 'voice-retry'));
        if (voice.state === 'audio_blocked') target.append(button('Ouvir áudio', 'voice-resume-audio', { class: 'rb-main' }));
        const vol = make('span', undefined, { class: 'vol' });
        vol.append(make('label', 'Volume', { for: 'online-voice-volume' }), make('input', undefined, { type: 'range', min: '0', max: '100', value: String(Math.round(voice.volume * 100)), id: 'online-voice-volume', 'aria-label': 'Volume da conversa' }));
        target.append(vol, button('Desligar', 'voice-leave', { 'aria-label': 'Desligar voz' }));
      }
      target.append(button('⚙ Áudio', 'voice-devices', { 'aria-expanded': String(voiceDevicesOpen), 'aria-controls': 'online-voice-devices', 'aria-label': 'Escolher microfone e saída de áudio' }));
      if (voiceError && !voice.joined) target.append(make('span', voiceError, { class: 'voice-note voice-error', role: 'alert' }));
      target.append(make('span', labels[voice.state] || 'Preparando voz…', { class: 'voice-note', role: 'status', 'aria-live': 'polite' }));
      if (voice.joined && voiceDiag && voice.state !== 'waiting') target.append(make('span', 'Diagnóstico: ' + voiceDiag, { class: 'voice-note' }));
    });
  }
  function renderSearchResults() {
    const target = panel.querySelector('#online-search-results');
    if (!target) return;
    target.replaceChildren();
    const q = searchQuery.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR').trim();
    if (!q) { target.append(make('p', 'Digite um nome ou gênero para indicar um título.')); return; }
    const found = availableTitles().filter((item) => `${item.title} ${item.genre} ${item.kind}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR').includes(q)).slice(0, 6);
    if (!found.length) { target.append(make('p', 'Nenhum título desta plataforma apareceu nesta amostra do catálogo.')); return; }
    for (const item of found) target.append(resultItem({ thumb: item.image, poster: true, name: item.title, sub: meta(item), action: button('Indicar', 'suggest-title', { 'data-id': item.id, 'aria-label': `Indicar ${item.title}` }) }));
  }
  async function copyInvite() {
    // Chamado direto do clique (sem run/await antes) para manter a ativação do usuário.
    const result = await copyText(invite, { navigator, document, container: inviteDialog.open ? inviteDialog : panel });
    if (result === 'copied') { inviteManual = false; say('Convite copiado. Trate-o como uma senha temporária.'); return; }
    if (result === 'empty') { say('Não há convite para copiar. Gere um novo convite.'); return; }
    inviteManual = true; inviteShown = true; selectInvite = true;
    if (!inviteDialog.open) inviteDialog.showModal();
    buildInviteDialog();
    say('Não foi possível copiar automaticamente. O convite está selecionado no campo: copie manualmente.');
  }
  function appendDirectSection() {
    const sec = make('div', undefined, { class: 'p2p-section' });
    sec.append(make('h5', 'Convidar de outra casa'));
    if (R && globalThis.crypto?.subtle) {
      sec.append(make('p', 'Gere um código curto e envie ao convidado. Ele digita o código no Dalari Cine e a conexão abre sozinha. O código vale para uma pessoa e expira em 15 minutos.'));
      if (!shortHost) sec.append(row(button('Gerar código', 'short-offer', { class: 'rb-main' })));
      else {
        sec.append(make('div', shortHost.code, { class: 'short-code', id: 'short-code', tabindex: '0', 'aria-label': 'Código de convite ' + shortHost.code }),
          row(button('Copiar código', 'short-copy', { class: 'rb-main' }), button('Novo código', 'short-offer')),
          make('p', shortHost.note, { role: 'status' }));
      }
    }
    const det = make('details', undefined, { class: 'p2p-manual' });
    det.append(make('summary', 'Sem serviço externo: trocar códigos grandes à mão'));
    det.addEventListener('toggle', () => { p2pManualOpen = det.open; });
    det.open = p2pManualOpen || !!hostLink || !(R && globalThis.crypto?.subtle);
    det.append(make('p', 'Você envia um código grande e o convidado devolve outro. A voz e a sala passam direto entre os dois aparelhos.' + (isDesktop ? '' : ' O código já inclui o convite: use este ou o de cima, não os dois.')));
    if (!hostLink) det.append(row(button('Gerar convite de conexão direta', 'p2p-offer')));
    else {
      const out = make('textarea', undefined, { id: 'p2p-offer-out', readonly: '', rows: '4', spellcheck: 'false', 'aria-label': 'Convite de conexão direta' });
      out.value = hostLink.code;
      const inp = make('textarea', undefined, { id: 'p2p-answer-input', rows: '3', spellcheck: 'false', placeholder: 'DT2.… (resposta do convidado)', 'aria-label': 'Resposta do convidado' });
      inp.value = p2pAnswerDraft;
      det.append(make('label', '1. Envie este código ao convidado', { for: 'p2p-offer-out' }), out, row(button('Copiar código', 'p2p-copy-offer', { class: 'rb-main' })),
        make('label', '2. Cole aqui a resposta dele', { for: 'p2p-answer-input' }), inp, row(button('Conectar', 'p2p-connect', { class: 'rb-main' })));
    }
    sec.append(det);
    if (hostLinks.length) sec.append(make('p', hostLinks.length + ' conexão(ões) direta(s) aberta(s).'));
    if (p2pNote) sec.append(make('p', p2pNote, { role: 'status' }));
    inviteDialog.append(sec);
  }
  function buildInviteDialog() {
    const wasFocused = document.activeElement?.id === 'rv3-invite-field';
    const answerFocused = document.activeElement?.id === 'p2p-answer-input';
    inviteDialog.replaceChildren();
    const s = snapshot, host = client?.role === 'host';
    inviteDialog.append(make('h4', 'Convidar para a sala', { id: 'rv3-invite-title' }));
    if (!host) { inviteDialog.append(make('p', 'Só o Host convida outras pessoas.'), row(button('Fechar', 'invite-close'))); return; }
    const count = s?.participants?.length || 1, cap = capacityOf(), pend = s?.pendingGuests?.length || 0;
    const canInvite = count + pend < cap;
    inviteDialog.append(make('p', `A sala tem ${count} de ${cap} lugares ocupados${pend ? ` e ${pend} pedido(s) aguardando sua aprovação` : ''}.`));
    if (!canInvite) inviteDialog.append(make('p', pend ? 'Aprove ou negue os pedidos na tela da sala antes de convidar mais gente.' : 'A sala está cheia. Remova alguém pelo menu da sala para liberar um lugar.'));
    else if (isDesktop && P2P) {
      inviteDialog.append(make('p', 'Cada aparelho tem a própria sala local, então use a conexão direta abaixo: o código inclui o convite, vale 15 minutos e serve para uma pessoa. Trate-o como senha temporária.'));
    } else if (invite) {
      inviteDialog.append(make('p', 'Convite de uso único, válido por 15 minutos, para uma pessoa. Trate-o como uma senha temporária e envie só à pessoa desejada. Gerar outro convite cancela este.'));
      const field = make('input', undefined, { readonly: '', type: inviteShown ? 'text' : 'password', id: 'rv3-invite-field', 'aria-label': 'Convite da sala', autocomplete: 'off' });
      field.value = invite;
      const f = make('div', undefined, { class: 'invite-field' });
      f.append(field, button(inviteShown ? 'Ocultar' : 'Mostrar', 'invite-reveal', { 'aria-pressed': String(inviteShown) }));
      inviteDialog.append(f);
      if (inviteManual) inviteDialog.append(make('p', 'Não foi possível copiar automaticamente (comum em páginas http da rede local). O convite está selecionado acima: pressione Ctrl+C (Cmd+C no Mac) ou toque e segure no campo e escolha Copiar.', { role: 'status' }));
      if (selectInvite || (inviteManual && wasFocused)) { selectInvite = false; field.focus({ preventScroll: true }); field.select(); }
    } else inviteDialog.append(make('p', s?.inviteState === 'used' ? 'O convite anterior já foi usado. Gere um novo para a próxima pessoa.' : s?.inviteState === 'expired' ? 'O convite anterior expirou.' : 'Gere um convite de uso único para a próxima pessoa.'));
    if (canInvite && P2P) appendDirectSection();
    const actions = row();
    if (canInvite && !(isDesktop && P2P)) actions.append(invite ? button('Copiar convite', 'copy', { class: 'rb-main' }) : button('Gerar novo convite', 'invite', { class: 'rb-main' }));
    actions.append(button('Fechar', 'invite-close'));
    inviteDialog.append(actions);
    if (answerFocused) inviteDialog.querySelector('#p2p-answer-input')?.focus({ preventScroll: true });
  }
  function openCtx(which) {
    tab = which; ctxOpen = true; uiVersion++;
    renderTabs(); renderPanel();
    if (window.matchMedia('(max-width:900px)').matches) $('#rv3-ctx-toggle').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  async function submitYouTube(videoId, videoTitle) {
    await run(async () => {
      if (snapshot.selectedMatch) await client.selectYouTubeVideo(snapshot.selectedMatch, videoId);
      else await client.openYouTubeVideo(videoId, videoTitle || 'Vídeo do YouTube');
      apply(client.snapshot);
      say('Vídeo aberto para a sala.');
    });
  }
  async function runYouTubeSearch() {
    await run(async () => {
      youtubeResults = await client.searchYouTube(panel.querySelector('#online-youtube-search').value);
      youtubeSearched = true;
      uiVersion++; renderPanel();
      say(youtubeResults.length ? `${youtubeResults.length} vídeos encontrados.` : 'Nenhum vídeo encontrado. Tente outros termos ou cole o link direto.');
    });
  }
  function openYouTubeLink() {
    const videoId = window.DuoYouTubePlayer?.parseVideoId(panel.querySelector('#online-youtube-url').value);
    if (!videoId) { say('Cole um link válido do YouTube para o vídeo exato.'); return; }
    youtubeLink = ''; return submitYouTube(videoId, 'Vídeo do YouTube');
  }

  /* ---------- eventos ---------- */
  panel.addEventListener('input', (e) => {
    if (e.target.id === 'online-room-search') { searchQuery = e.target.value; renderSearchResults(); }
    if (e.target.id === 'online-youtube-search') { youtubeQuery = e.target.value; if (!youtubeQuery.trim() && (youtubeResults.length || youtubeSearched)) { youtubeResults = []; youtubeSearched = false; uiVersion++; renderPanel(); } }
    if (e.target.id === 'online-youtube-url') youtubeLink = e.target.value;
    if (e.target.id === 'p2p-answer-input') {
      p2pAnswerDraft = e.target.value;
      if (P2P?.looksLikeCode(p2pAnswerDraft) && p2pAnswerDraft.trim().length > 60 && !busy) void run(p2pConnect);   // colou a resposta: conecta
    }
    if (e.target.id === 'online-invite-input' && ((P2P?.looksLikeCode(e.target.value) && e.target.value.trim().length > 60) || R?.looksLikeShortCode(e.target.value)) && !busy && !guestLink) {
      panel.querySelector('[data-online-act=join]')?.click();                                                    // colou o convite: entra
    }
    if (e.target.id === 'online-voice-volume') voice?.setVolume(Number(e.target.value) / 100);
    if (e.target.id === 'rv3-seek') { scrubbing = true; updateBar(); }
  });
  panel.addEventListener('change', (e) => {
    if (e.target.id !== 'rv3-seek') return;
    const dur = youtube?.duration() || 0;
    scrubbing = false;
    if (!dur || !isYouTube()) return;
    const seconds = Number(e.target.value) / 1000 * dur;
    void run(async () => { await client.playback(snapshot.media.titleId, 'seek', seconds); apply(client.snapshot); });
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'online-youtube-search') { e.preventDefault(); void runYouTubeSearch(); }
    if (e.key === 'Enter' && e.target.id === 'online-youtube-url') { e.preventDefault(); void openYouTubeLink(); }
    if (e.target.getAttribute?.('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const order = ['search', 'match'], i = order.indexOf(tab);
      tab = e.key === 'Home' ? order[0] : e.key === 'End' ? order[1] : order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      renderTabs(); renderPanel(); panel.querySelector(`#rv3-tab-${tab}`)?.focus();
    }
    if (e.key === 'Escape' && !menu.hidden) { setMenu(false); menuBtn.focus(); }
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest?.('.rv3-menuwrap')) setMenu(false); });
  inviteDialog.addEventListener('click', (e) => { if (e.target === inviteDialog) inviteDialog.close(); });
  inviteDialog.addEventListener('close', () => { inviteShown = false; inviteManual = false; });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-online-act]'); if (!b) return;
    const act = b.dataset.onlineAct;
    if (act === 'create') return void run(async () => {
      const field = panel.querySelector('#online-display-name');
      if (!await adapter.saveProfileName(field.value, false)) { say('Defina um nome válido antes de criar a sala.'); field.focus(); return; }
      const c = new DuoRoomClient({ serviceUrl: location.origin, allowInsecure: isPrivateLanHttp() });
      const d = await c.createRoom(adapter.getProfileName(), { maxParticipants: 4 }); tel?.event('room_created'); client = c; voice?.attach(c); invite = d.invite;
      apply(await client.getState({ after: 0 })); connect(); say('Sala criada. Use Convidar para copiar o convite e enviar apenas à pessoa desejada.');
    });
    if (act === 'join') return void run(async () => {
      const field = panel.querySelector('#online-display-name');
      if (!await adapter.saveProfileName(field.value, false)) { say('Defina um nome válido antes de entrar.'); field.focus(); return; }
      const text = panel.querySelector('#online-invite-input').value;
      if (R?.looksLikeShortCode(text) && P2P) { await shortJoin(text, adapter.getProfileName()); return; }
      if (P2P?.looksLikeCode(text)) { await p2pJoin(text, adapter.getProfileName()); return; }
      if (isDesktop && P2P) { say('No aplicativo, digite o código curto do Host (XXXX-XXXX) ou cole o código de conexão direta (começa com DT). O convite antigo (123456.…) só funciona no mesmo servidor.'); return; }
      const c = new DuoRoomClient({ serviceUrl: location.origin, allowInsecure: isPrivateLanHttp() });
      await c.joinRoom(text, adapter.getProfileName()); client = c; voice?.attach(c);
      apply(await client.getState({ after: 0 })); connect(); say('Pedido enviado. Aguarde a aprovação do Host.');
    });
    if (act === 'menu') { const open = menu.hidden; if (open) buildMenu(); setMenu(open); return; }
    if (act === 'invite-open') { setMenu(false); buildInviteDialog(); if (!inviteDialog.open) inviteDialog.showModal(); return; }
    if (act === 'invite-close') return void inviteDialog.close();
    if (act === 'invite-reveal') { inviteShown = !inviteShown; buildInviteDialog(); panel.querySelector('[data-online-act=invite-reveal]')?.focus(); return; }
    if (act === 'copy') return void copyInvite();
    if (act === 'p2p-offer') return void run(p2pOffer);
    if (act === 'short-offer') return void run(shortOffer);
    if (act === 'short-copy') return void p2pCopy(shortHost?.code, inviteDialog.querySelector('#short-code'));
    if (act === 'p2p-copy-offer') return void p2pCopy(hostLink?.code, inviteDialog.querySelector('#p2p-offer-out'));
    if (act === 'p2p-connect') return void run(p2pConnect);
    if (act === 'p2p-copy-answer') return void p2pCopy(guestLink?.answer, panel.querySelector('#p2p-answer-out'));
    if (act === 'p2p-cancel') { closeP2P(); render(); say('Conexão direta cancelada.'); return; }
    if (act === 'leave') return void run(async () => { try { await client.leaveRoom(); } catch { /* sair sempre funciona localmente */ } disconnect(); say('Você saiu da sala.'); });
    if (act === 'remove') {
      const id = b.dataset.id;
      if (removeArmed !== id) { removeArmed = id; buildMenu(); menu.querySelector(`[data-id="${id}"]`)?.focus(); return; }
      return void run(async () => { const name = nameFor(id); await client.removeGuest(id); removeArmed = null; setMenu(false); apply(await client.getState({ after: 0 })); say(`${name} foi removido(a). A rodada foi reiniciada.`); });
    }
    if (act === 'close') {
      if (!closeArmed) { closeArmed = true; buildMenu(); menu.querySelector('button')?.focus(); return; }
      return void run(async () => { await client.closeRoom(); disconnect(); say('Sala fechada.'); });
    }
    if (act === 'approve' || act === 'deny') return void run(async () => {
      const id = b.dataset.id, who = snapshot.pendingGuests?.find((p) => p.id === id)?.displayName || 'A pessoa';
      if (act === 'approve') await client.approveGuest(id); else await client.denyGuest(id);
      apply(await client.getState({ after: 0 })); say(act === 'approve' ? `${who} entrou na sala.` : 'Entrada negada.');
    });
    if (act === 'invite') return void run(async () => { const d = await client.newInvite(); invite = d.invite; inviteShown = false; inviteManual = false; render(); say('Novo convite gerado.'); });
    if (act === 'platform') return void run(async () => {
      if (b.dataset.platform === snapshot.platform) return;
      await client.selectPlatform(b.dataset.platform); searchQuery = ''; uiVersion++; apply(client.snapshot);
    });
    if (act === 'tab') { tab = b.dataset.tab; renderTabs(); renderPanel(); return; }
    if (act === 'tab-search' || act === 'tab-match') return void openCtx(act === 'tab-search' ? 'search' : 'match');
    if (act === 'ctx-toggle') { ctxOpen = !ctxOpen; renderTabs(); return; }
    if (act === 'link-toggle') { linkOpen = !linkOpen; uiVersion++; renderPanel(); panel.querySelector(linkOpen ? '#online-youtube-url' : '#rv3-link-btn')?.focus(); return; }
    if (act === 'voice-join') return void run(async () => {
      voiceError = ''; voiceJoinAt = Date.now();
      try { await voice.join(); } catch (e) { voiceError = e.message || 'Não foi possível ligar a voz.'; renderVoice(); return; }
      renderVoice(); apply(client.snapshot);
    });
    if (act === 'ptt-key') { pttCapturing = true; deviceKey = ''; void renderDevices(); return; }
    if (act === 'voice-devices') { voiceDevicesOpen = !voiceDevicesOpen; deviceKey = ''; renderVoice(); return; }
    if (act === 'voice-leave') return void run(async () => { await voice.leave(); apply(client.snapshot); });
    if (act === 'voice-mute') return void voice.toggleMute();
    if (act === 'voice-retry') return void run(async () => { await voice.retry(); apply(client.snapshot); });
    if (act === 'voice-resume-audio') return void run(async () => { await voice.audio.play(); voice.emit('connected'); });
    if (act === 'details') return void adapter.openTitle(b.dataset.id);
    if (act === 'surprise' || act === 'recommend') return void api.startRound(act);
    if (act === 'suggest-title') return void run(async () => { await client.pickManually(b.dataset.id); apply(client.snapshot); });
    if (act === 'yes' || act === 'no') return void run(async () => { await client.vote(b.dataset.id, act); apply(client.snapshot); });
    if (act === 'nf-associate') return void run(async () => {
      const tabId = Number(b.dataset.tab), watchId = b.dataset.watch;
      if (!panel.querySelector(`#nf-confirm-${tabId}`)?.checked) { say('Marque a confirmação: só você sabe se essa aba é o título escolhido.'); return; }
      if (!snapshot.selectedMatch) return;
      await nfLink.associate(tabId, watchId);
      say('Título associado. Os outros recebem o link /watch/' + watchId + '.');
    });
    if (act === 'nf-desktop-associate') return void run(async () => {
      const watchId = b.dataset.watch;
      if (!window.duoDesktop || !snapshot?.selectedMatch || !/^[0-9]{1,12}$/.test(watchId) || desktopNetflixState?.watchId !== watchId) return;
      if (!panel.querySelector('#nf-desktop-confirm')?.checked) { say('Confirme que o título aberto na Netflix é o mesmo do match.'); return; }
      const titleId = snapshot.selectedMatch;
      await client.selectNetflixTitle(titleId, watchId);
      if (Number.isFinite(desktopNetflixState.positionSec)) {
        await client.playbackNetflix(titleId, watchId, desktopNetflixState.playing ? 'play' : 'pause', desktopNetflixState.positionSec);
      }
      apply(client.snapshot);
      say('Título associado. Play e pausa passam a acompanhar a sala.');
    });
    if (act === 'nf-sync') { try { nfLink.sync(Number(b.dataset.tab), b.dataset.watch); say('Sincronizando esta aba da Netflix.'); } catch { say('Essa aba não é o título da sala.'); } return; }
    if (act === 'nf-unsync') { nfLink.unsync(); say('Sincronização desligada nesta aba.'); return; }
    if (act === 'youtube-open') return void openYouTubeLink();
    if (act === 'youtube-search') return void runYouTubeSearch();
    if (act === 'youtube-result') return void submitYouTube(b.dataset.videoId, b.dataset.videoTitle);
    if (act === 'fullscreen') return void youtube?.fullscreen?.();
    if (act === 'youtube-toggle') return void run(async () => {
      if (!isYouTube()) return;
      if (snapshot.playback?.state === 'playing' && youtube?.needsLocalStart?.()) { youtube.playLocal(); updateBar(); return; }
      const action = snapshot.playback?.state === 'playing' ? 'pause' : 'play';
      const seconds = youtube?.currentPosition() || snapshot.playback?.positionSec || 0;
      if (action === 'play') youtube?.playLocal();
      else youtube?.pauseLocal();
      await client.playback(snapshot.media.titleId, action, seconds); apply(client.snapshot);
    });
  });
  setInterval(() => { if (client && isYouTube()) updateBar(); }, 500);
  render();
})();
