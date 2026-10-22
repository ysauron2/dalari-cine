"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const scriptPath = path.join(__dirname, "..", "userscripts", "sessao-a-dois-youtube.user.js");
const source = fs.readFileSync(scriptPath, "utf8");

class FakeElement {
  constructor(tag) {
    this.tag = tag; this.attrs = {}; this.children = []; this.style = {};
    this.listeners = {}; this.textContent = ""; this.parentNode = null;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ type: "click" }); }
  walk() { return this.children.flatMap((c) => [c, ...c.walk()]); }
}

function createFakeVideo(overrides = {}) {
  return {
    paused: true, ended: false, currentTime: 10, duration: 120,
    playCalls: 0, pauseCalls: 0, playBehavior: () => Promise.resolve(),
    play() { this.playCalls += 1; return this.playBehavior().then(() => { this.paused = false; }); },
    pause() { this.pauseCalls += 1; this.paused = true; },
    ...overrides,
  };
}

// Executa o userscript em um contexto VM com DOM falso. O <video> e obtido a
// cada document.querySelector, entao trocar world.video simula a navegacao SPA.
function loadUserscript({ video = null } = {}) {
  const world = { video, intervals: [], docListeners: {}, winListeners: {} };
  const body = new FakeElement("body");
  const document = {
    body,
    documentElement: body,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => body.walk().find((el) => el.attrs.id === id) || null,
    querySelector: () => world.video,
    addEventListener: (type, fn) => { world.docListeners[type] = fn; },
  };
  const sandbox = {
    document,
    Number,
    Math,
    setInterval: (fn, ms) => { world.intervals.push({ fn, ms }); return world.intervals.length; },
    addEventListener: (type, fn) => { world.winListeners[type] = fn; },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: scriptPath });
  world.body = body;
  world.overlay = () => document.getElementById("sessao-a-dois-overlay");
  world.button = (action) => world.overlay().walk().find((el) => el.attrs["data-action"] === action);
  world.text = (role) => world.overlay().walk().find((el) => el.attrs["data-role"] === role).textContent;
  return world;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("metadata block is limited to YouTube and has no network/update/dependency keys", () => {
  assert.ok(source.startsWith("// ==UserScript=="));
  const block = source.match(/\/\/ ==UserScript==\r?\n([\s\S]*?)\/\/ ==\/UserScript==/);
  assert.ok(block, "metadata block present at top");
  const entries = [...block[1].matchAll(/^\/\/ @(\S+)[ \t]*(.*)$/gm)].map((m) => [m[1], m[2].trim()]);
  const keys = entries.map(([k]) => k);
  const matches = entries.filter(([k]) => k === "match").map(([, v]) => v);
  assert.deepEqual(matches, ["https://www.youtube.com/*", "https://m.youtube.com/*"]);
  for (const forbidden of ["require", "connect", "updateURL", "downloadURL", "installURL", "include", "exclude", "resource", "icon", "supportURL", "homepageURL"]) {
    assert.ok(!keys.includes(forbidden), `no @${forbidden}`);
  }
  assert.deepEqual(entries.filter(([k]) => k === "grant"), [["grant", "none"]]);
  assert.ok(!/<all_urls>|http:\/\//.test(block[1]));
});

test("code uses no networking, storage, credentials, GM APIs or dynamic code", () => {
  const code = source.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");
  const forbidden = [
    /\bfetch\b/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\bimport\s*\(/, /\brequire\s*\(/,
    /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /\bcaches\b/, /\bGM[_.]/, /unsafeWindow/,
    /\beval\b/, /new Function/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /<script/i,
    /\bpostMessage\b/, /navigator\./, /credentials/i,
  ];
  for (const pattern of forbidden) assert.ok(!pattern.test(code), `must not match ${pattern}`);
});

test("overlay mounts once, is accessible, and starts with 'no video' state", () => {
  const world = loadUserscript();
  const overlay = world.overlay();
  assert.ok(overlay);
  assert.equal(overlay.getAttribute("role"), "region");
  assert.ok(overlay.getAttribute("aria-label"));
  const buttons = overlay.walk().filter((el) => el.tag === "button");
  assert.deepEqual(buttons.map((b) => b.attrs["data-action"]), ["play", "pause", "refresh", "seek"]);
  for (const b of buttons) {
    assert.equal(b.getAttribute("type"), "button");
    assert.ok(b.getAttribute("aria-label"), "aria-label");
    assert.ok(b.textContent.length > 0);
    assert.ok(parseInt(b.style.minHeight, 10) >= 44, "touch target >= 44px");
  }
  assert.equal(overlay.walk().find((el) => el.attrs["data-role"] === "state").getAttribute("aria-live"), "polite");
  assert.match(world.text("state"), /Sem vídeo/);
  // Ticks repetidos (intervalo / eventos de navegacao) nao podem duplicar o painel.
  world.intervals[0].fn();
  world.docListeners["yt-navigate-finish"]();
  assert.equal(world.body.children.length, 1);
  assert.equal(world.intervals[0].ms, 1000);
});

test("Play, Pause, Refresh and +30 s drive the current video and show state", async () => {
  const video = createFakeVideo({ currentTime: 65, duration: 600 });
  const world = loadUserscript({ video });
  assert.match(world.text("state"), /Pausado — 1:05 \/ 10:00/);

  world.button("play").click();
  await flush();
  assert.equal(video.playCalls, 1);
  assert.match(world.text("state"), /Tocando/);

  world.button("pause").click();
  assert.equal(video.pauseCalls, 1);
  assert.match(world.text("state"), /Pausado/);

  world.button("seek").click();
  assert.equal(video.currentTime, 95);
  assert.match(world.text("state"), /1:35/);

  video.currentTime = 200; // alterado fora do painel
  world.button("refresh").click();
  assert.match(world.text("state"), /3:20/);
});

test("+30 s is clamped to duration and refused when duration is unknown", () => {
  const video = createFakeVideo({ currentTime: 110, duration: 120 });
  const world = loadUserscript({ video });
  world.button("seek").click();
  assert.equal(video.currentTime, 120);

  video.currentTime = 5;
  video.duration = Infinity; // ao vivo
  world.button("seek").click();
  assert.equal(video.currentTime, 5);
  assert.match(world.text("message"), /Duração desconhecida/);

  video.duration = NaN;
  world.button("seek").click();
  assert.equal(video.currentTime, 5);
});

test("with no video, buttons do nothing harmful and report a message", () => {
  const world = loadUserscript({ video: null });
  for (const action of ["play", "pause", "seek"]) {
    world.button(action).click();
    assert.match(world.text("message"), /Nenhum vídeo/);
  }
  world.button("refresh").click();
  assert.match(world.text("state"), /Sem vídeo/);
});

test("video is looked up dynamically: SPA navigation swaps the element", () => {
  const first = createFakeVideo({ currentTime: 1, duration: 100 });
  const second = createFakeVideo({ currentTime: 50, duration: 300 });
  const world = loadUserscript({ video: first });
  assert.match(world.text("state"), /0:01 \/ 1:40/);

  world.video = second; // novo <video> apos navegacao
  world.docListeners["yt-navigate-finish"]();
  assert.match(world.text("state"), /0:50 \/ 5:00/);
  world.button("pause").click();
  assert.equal(first.pauseCalls, 0);
  assert.equal(second.pauseCalls, 1);

  world.video = null; // navegou para pagina sem video
  world.intervals[0].fn();
  assert.match(world.text("state"), /Sem vídeo/);
  world.button("seek").click();
  assert.equal(second.currentTime, 50);
  assert.match(world.text("message"), /Nenhum vídeo/);
});

test("blocked or failed play shows a message instead of throwing", async () => {
  const notAllowed = Object.assign(new Error("x"), { name: "NotAllowedError" });
  const blocked = createFakeVideo({ playBehavior: () => Promise.reject(notAllowed) });
  const world = loadUserscript({ video: blocked });
  world.button("play").click();
  await flush();
  assert.match(world.text("message"), /bloqueou o play/);

  const failing = createFakeVideo({ play() { throw new Error("boom"); } });
  const world2 = loadUserscript({ video: failing });
  world2.button("play").click();
  assert.match(world2.text("message"), /Não foi possível tocar/);
});

test("overlay is re-mounted if the page removes it", () => {
  const world = loadUserscript();
  world.body.children.length = 0;
  world.intervals[0].fn();
  assert.ok(world.overlay());
});
