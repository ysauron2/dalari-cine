"use strict";
// DOM falso: estes testes NAO provam funcionamento na Netflix real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const spikeRoot = path.join(__dirname, "..");
const {
  ERROR_CODES, createVideoController, createNetflixVideoFinder, createPageVideoFinder, readVideoIdFromLocation,
} = require("../src/video-controller.js");
const { describeResponse } = require("../popup/popup-model.js");

const WATCH = "https://www.netflix.com/watch/80100172";

function fakeVideo({ width = 1280, height = 720, inPlayer = true, ...rest } = {}) {
  return {
    paused: true, ended: false, currentTime: 10, duration: 3600, readyState: 4,
    playCalls: 0, pauseCalls: 0,
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
    pause() { this.pauseCalls += 1; this.paused = true; },
    getBoundingClientRect: () => ({ width, height }),
    closest: () => (inPlayer ? {} : null),
    ...rest,
  };
}

const docWith = (videos) => ({ querySelectorAll: () => videos, querySelector: () => videos[0] || null });

test("readVideoIdFromLocation: Netflix returns only the numeric /watch id", () => {
  assert.equal(readVideoIdFromLocation({ href: WATCH }), "80100172");
  assert.equal(readVideoIdFromLocation({ href: `${WATCH}?trackId=1&tctx=2` }), "80100172");
  assert.equal(readVideoIdFromLocation({ href: `${WATCH}/` }), "80100172");
  for (const href of [
    "https://www.netflix.com/browse", "https://www.netflix.com/title/80100172",
    "https://www.netflix.com/watch/abc", "https://www.netflix.com/watch/", "https://www.netflix.com/watch/12/x",
    "https://www.netflix.com/browse?v=123",
  ]) assert.equal(readVideoIdFromLocation({ href }), null, href);
  // YouTube segue igual
  assert.equal(readVideoIdFromLocation({ href: "https://www.youtube.com/watch?v=abc" }), "abc");
});

test("Netflix finder picks the visible player video and skips hidden/preview ones", () => {
  const hidden = fakeVideo({ width: 0, height: 0 });
  const bigOutside = fakeVideo({ width: 1920, height: 1080, inPlayer: false });
  const main = fakeVideo({ width: 800, height: 450 });
  const small = fakeVideo({ width: 100, height: 50 });
  const find = (videos, href = WATCH) => createNetflixVideoFinder(docWith(videos), () => ({ href }))();
  assert.equal(find([hidden, bigOutside, small, main]), main);
  assert.equal(find([small, main]), main);
  const smallOutside = fakeVideo({ width: 100, height: 50, inPlayer: false });
  assert.equal(find([smallOutside, bigOutside]), bigOutside, "sem container conhecido, maior area visivel");
  assert.equal(find([hidden]), null);
  assert.equal(find([]), null);
  assert.equal(find([main], "https://www.netflix.com/browse"), null, "fora de /watch nao devolve video");
  assert.equal(find([{ ...main, getBoundingClientRect: undefined }]), null);
});

test("page finder chooses Netflix strategy by host and keeps YouTube selectors otherwise", () => {
  const main = fakeVideo();
  const nf = createPageVideoFinder(docWith([main]), () => ({ href: WATCH }));
  assert.equal(nf(), main);
  const yt = { name: "yt" };
  const ytFinder = createPageVideoFinder({ querySelector: (s) => (s === "video" ? yt : null) }, () => ({ href: "https://www.youtube.com/watch?v=a" }));
  assert.equal(ytFinder(), yt);
  assert.equal(createPageVideoFinder({ querySelector: () => null }, () => null)(), null);
});

async function controllerFor(video, href = WATCH) {
  const holder = { videos: video ? [video] : [], href };
  return {
    holder,
    controller: createVideoController({
      findCurrentVideo: () => createNetflixVideoFinder(docWith(holder.videos), () => ({ href: holder.href }))(),
      getLocation: () => ({ href: holder.href }),
    }),
  };
}

test("controller on Netflix: state, play, pause, seek", async () => {
  const video = fakeVideo();
  const { controller } = await controllerFor(video);
  const state = await controller.handleMessage({ type: "GET_STATE" });
  assert.equal(state.state.videoId, "80100172");
  assert.equal(state.state.durationSeconds, 3600);
  assert.equal((await controller.handleMessage({ type: "PLAY" })).state.isPlaying, true);
  assert.equal((await controller.handleMessage({ type: "PAUSE" })).state.isPlaying, false);
  await controller.handleMessage({ type: "SEEK_TO_SECONDS", seconds: 125 });
  assert.equal(video.currentTime, 125);
});

test("controller on Netflix: no video, loading, autoplay block, SPA change", async () => {
  const { controller, holder } = await controllerFor(null);
  const none = await controller.handleMessage({ type: "GET_STATE" });
  assert.equal(none.state.hasVideo, false);
  assert.equal(none.state.videoId, "80100172");
  assert.equal((await controller.handleMessage({ type: "PLAY" })).error.code, ERROR_CODES.NO_VIDEO);

  const loading = fakeVideo({ duration: NaN, readyState: 0, currentTime: 0 });
  holder.videos = [loading];
  const seek = await controller.handleMessage({ type: "SEEK_TO_SECONDS", seconds: 5 });
  assert.equal(seek.error.code, ERROR_CODES.DURATION_UNKNOWN);
  assert.equal(loading.currentTime, 0);
  assert.match(describeResponse(await controller.handleMessage({ type: "GET_STATE" })), /carregando, 0:00 \/ --:--/);

  const blocked = fakeVideo({ play: () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })) });
  holder.videos = [blocked];
  assert.equal((await controller.handleMessage({ type: "PLAY" })).error.code, ERROR_CODES.PLAY_BLOCKED_BY_BROWSER);

  holder.href = "https://www.netflix.com/watch/70143836"; // outro titulo, sem recarregar
  assert.equal((await controller.handleMessage({ type: "GET_STATE" })).state.videoId, "70143836");
  holder.href = "https://www.netflix.com/browse";
  assert.equal((await controller.handleMessage({ type: "GET_STATE" })).state.hasVideo, false);
});

test("popup model keeps YouTube text and reports loading only when readyState < 2", () => {
  const base = { hasVideo: true, videoId: "x", isPlaying: false, isEnded: false, currentTimeSeconds: 5, durationSeconds: 60 };
  assert.equal(describeResponse({ ok: true, state: base }), "Video x: pausado, 0:05 / 1:00");
  assert.match(describeResponse({ ok: true, state: { ...base, readyState: 1 } }), /carregando/);
  assert.match(describeResponse({ ok: true, state: { ...base, readyState: 4 } }), /pausado/);
  assert.match(describeResponse(null), /netflix\.com\/watch/);
});

test("content script on Netflix answers its own extension through the Netflix finder", async () => {
  const video = fakeVideo();
  let listener = null;
  const sandbox = {
    chrome: { runtime: { id: "me", onMessage: { addListener: (fn) => { listener = fn; } } } },
    document: docWith([video]),
    window: { location: { href: WATCH } },
    URL,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ["src/video-controller.js", "src/content-script.js"]) {
    vm.runInContext(fs.readFileSync(path.join(spikeRoot, file), "utf8"), sandbox, { filename: file });
  }
  const response = await new Promise((resolve) => listener({ type: "GET_STATE" }, { id: "me" }, resolve));
  assert.equal(response.state.videoId, "80100172");
  assert.equal(listener({ type: "GET_STATE" }, { id: "other" }, () => {}), false);
});

test("manifest: Netflix entry is restricted to /watch/* with no extra permissions", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(spikeRoot, "manifest.json"), "utf8"));
  const entry = manifest.content_scripts.find((e) => e.matches.some((m) => m.includes("netflix")));
  assert.deepEqual(entry.matches, ["https://www.netflix.com/watch/*"]);
  assert.deepEqual(manifest.permissions, []);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.world, undefined);
  assert.equal(entry.world, undefined, "isolated world only; never MAIN");
});

// ---- Userscript ----
const usPath = path.join(spikeRoot, "userscripts", "sessao-a-dois-netflix.user.js");
const usSource = fs.readFileSync(usPath, "utf8");

class FakeElement {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.style = {}; this.listeners = {}; this.textContent = ""; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  walk() { return this.children.flatMap((c) => [c, ...c.walk()]); }
}

function loadUserscript({ videos = [], pathname = "/watch/80100172" } = {}) {
  const world = { videos, intervals: [], pathname };
  const body = new FakeElement("body");
  const document = {
    body, documentElement: body,
    createElement: (t) => new FakeElement(t),
    getElementById: (id) => body.walk().find((e) => e.attrs.id === id) || null,
    querySelectorAll: () => world.videos,
  };
  const sandbox = {
    document, Number, Math, RegExp,
    setInterval: (fn, ms) => { world.intervals.push({ fn, ms }); return 1; },
    addEventListener: () => {},
  };
  Object.defineProperty(sandbox, "location", { get: () => ({ pathname: world.pathname }) });
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(usSource, sandbox, { filename: usPath });
  world.button = (a) => document.getElementById("sessao-a-dois-overlay").walk().find((e) => e.attrs["data-action"] === a);
  world.text = (r) => document.getElementById("sessao-a-dois-overlay").walk().find((e) => e.attrs["data-role"] === r).textContent;
  return world;
}

test("Netflix userscript metadata: only /watch/*, grant none, no network/update keys", () => {
  const block = usSource.match(/\/\/ ==UserScript==\r?\n([\s\S]*?)\/\/ ==\/UserScript==/);
  assert.ok(usSource.startsWith("// ==UserScript=="));
  const entries = [...block[1].matchAll(/^\/\/ @(\S+)[ \t]*(.*)$/gm)].map((m) => [m[1], m[2].trim()]);
  assert.deepEqual(entries.filter(([k]) => k === "match"), [["match", "https://www.netflix.com/watch/*"]]);
  assert.deepEqual(entries.filter(([k]) => k === "grant"), [["grant", "none"]]);
  for (const k of ["require", "connect", "updateURL", "downloadURL", "include", "exclude", "resource", "icon"]) {
    assert.ok(!entries.some(([key]) => key === k), `no @${k}`);
  }
});

test("Netflix userscript code has no network, storage, credentials or dynamic code", () => {
  const code = usSource.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");
  for (const re of [
    /\bfetch\b/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\bimport\s*\(/, /\brequire\s*\(/,
    /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /\bGM[_.]/, /unsafeWindow/, /netflix\.appContext/,
    /\beval\b/, /new Function/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /<script/i,
    /\bpostMessage\b/, /navigator\./, /credentials/i, /https?:\/\//,
  ]) assert.ok(!re.test(code), `must not match ${re}`);
});

test("Netflix userscript: accessible overlay, controls and states", async () => {
  const video = fakeVideo({ currentTime: 65 });
  const world = loadUserscript({ videos: [fakeVideo({ width: 0, height: 0 }), video] });
  const overlay = world.button("play");
  assert.ok(overlay);
  const buttons = ["play", "pause", "refresh", "seek"].map(world.button);
  for (const b of buttons) {
    assert.equal(b.getAttribute("type"), "button");
    assert.ok(b.getAttribute("aria-label"));
    assert.ok(parseInt(b.style.minHeight, 10) >= 44);
  }
  assert.match(world.text("state"), /Título 80100172: Pausado — 1:05 \/ 1:00:00/);
  world.button("play").click();
  await new Promise((r) => setImmediate(r));
  assert.equal(video.playCalls, 1);
  assert.match(world.text("state"), /Tocando/);
  world.button("pause").click();
  assert.equal(video.pauseCalls, 1);
  world.button("seek").click();
  assert.equal(video.currentTime, 95);
  video.currentTime = 3590;
  world.button("seek").click();
  assert.equal(video.currentTime, 3600);
  assert.equal(world.intervals[0].ms, 1000);
});

test("Netflix userscript: loading, unknown duration, blocked play, no video, SPA exit", async () => {
  const loading = fakeVideo({ duration: NaN, readyState: 0, currentTime: 0 });
  const world = loadUserscript({ videos: [loading] });
  assert.match(world.text("state"), /Carregando/);
  world.button("seek").click();
  assert.equal(loading.currentTime, 0);
  assert.match(world.text("message"), /Duração desconhecida/);

  const blocked = fakeVideo({ play: () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })) });
  world.videos = [blocked];
  world.button("play").click();
  await new Promise((r) => setImmediate(r));
  assert.match(world.text("message"), /bloqueou o play/);

  world.videos = [];
  world.button("pause").click();
  assert.match(world.text("message"), /Nenhum vídeo/);

  world.videos = [fakeVideo()];
  world.pathname = "/browse"; // saiu do player via SPA, <video> residual ignorado
  world.intervals[0].fn();
  assert.match(world.text("state"), /Sem vídeo/);
});
