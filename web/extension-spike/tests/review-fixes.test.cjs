"use strict";
// DOM falso: cobre as correcoes da revisao (excecoes de pause/seek, listener, painel).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const spikeRoot = path.join(__dirname, "..");
const { ERROR_CODES, createVideoController } = require("../src/video-controller.js");

const WATCH = "https://www.netflix.com/watch/80100172";
const boom = () => { throw new Error("player recusou"); };

function fakeVideo(overrides = {}) {
  return {
    paused: true, ended: false, currentTime: 10, duration: 3600, readyState: 4,
    playCalls: 0, pauseCalls: 0,
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
    pause() { this.pauseCalls += 1; this.paused = true; },
    getBoundingClientRect: () => ({ width: 1280, height: 720 }),
    closest: () => ({}),
    ...overrides,
  };
}

function controllerFor(video) {
  return createVideoController({ findCurrentVideo: () => video, getLocation: () => ({ href: WATCH }) });
}

test("autoplay-blocked message is neutral (no YouTube wording)", async () => {
  const blocked = fakeVideo({ play: () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })) });
  const response = await controllerFor(blocked).handleMessage({ type: "PLAY" });
  assert.equal(response.error.code, ERROR_CODES.PLAY_BLOCKED_BY_BROWSER);
  assert.doesNotMatch(response.error.message, /youtube/i);
  assert.match(response.error.message, /Clique no video ou interaja com a pagina/);
});

test("pause() throwing becomes PAUSE_FAILED with state", async () => {
  const response = await controllerFor(fakeVideo({ pause: boom })).handleMessage({ type: "PAUSE" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.PAUSE_FAILED);
  assert.equal(response.state.hasVideo, true);
});

test("currentTime setter throwing becomes SEEK_FAILED and the controller keeps working", async () => {
  const video = fakeVideo();
  Object.defineProperty(video, "currentTime", { get: () => 10, set: boom });
  const controller = controllerFor(video);
  const seek = await controller.handleMessage({ type: "SEEK_TO_SECONDS", seconds: 20 });
  assert.equal(seek.ok, false);
  assert.equal(seek.error.code, ERROR_CODES.SEEK_FAILED);
  assert.equal(seek.state.currentTimeSeconds, 10);
  assert.equal((await controller.handleMessage({ type: "GET_STATE" })).ok, true);
});

test("handleMessage never rejects, even if the finder throws", async () => {
  const controller = createVideoController({ findCurrentVideo: boom, getLocation: () => ({ href: WATCH }) });
  const response = await controller.handleMessage({ type: "GET_STATE" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INTERNAL_ERROR);
});

function loadContentScript({ video, controllerStub } = {}) {
  let listener = null;
  const sandbox = {
    chrome: { runtime: { id: "me", onMessage: { addListener: (fn) => { listener = fn; } } } },
    document: { querySelectorAll: () => (video ? [video] : []), querySelector: () => video || null },
    window: { location: { href: WATCH } },
    URL, Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(spikeRoot, "src/video-controller.js"), "utf8"), sandbox);
  if (controllerStub) {
    sandbox.SessaoADoisVideoController = { createVideoController: () => controllerStub, createPageVideoFinder: () => () => null };
  }
  vm.runInContext(fs.readFileSync(path.join(spikeRoot, "src/content-script.js"), "utf8"), sandbox);
  return listener;
}

const ask = (listener, message) => new Promise((resolve) => listener(message, { id: "me" }, resolve));

test("content script: pause exception reaches the popup as a structured response", async () => {
  const response = await ask(loadContentScript({ video: fakeVideo({ pause: boom }) }), { type: "PAUSE" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "PAUSE_FAILED");
});

test("content script: rejection or sync throw from handleMessage yields a stable response", async () => {
  const expected = { ok: false, error: { code: "INTERNAL_ERROR", message: "Erro inesperado ao processar a mensagem." } };
  for (const handleMessage of [() => Promise.reject(new Error("x")), () => { throw new Error("x"); }]) {
    const listener = loadContentScript({ controllerStub: { handleMessage } });
    // JSON: o objeto vem de outro realm do vm (prototype diferente)
    assert.deepEqual(JSON.parse(JSON.stringify(await ask(listener, { type: "GET_STATE" }))), expected);
  }
});

test("content script: sendResponse throwing causes no unhandled rejection", async () => {
  const listener = loadContentScript({ video: fakeVideo() });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  assert.equal(listener({ type: "GET_STATE" }, { id: "me" }, () => { throw new Error("canal fechado"); }), true);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
});

// ---- Userscript ----
const usPath = path.join(spikeRoot, "userscripts", "sessao-a-dois-netflix.user.js");
const usSource = fs.readFileSync(usPath, "utf8");

class FakeElement {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.style = {}; this.listeners = {}; this.textContent = ""; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  walk() { return this.children.flatMap((c) => [c, ...c.walk()]); }
}

function loadUserscript(video) {
  const body = new FakeElement("body");
  const document = {
    body, documentElement: body,
    createElement: (t) => new FakeElement(t),
    getElementById: (id) => body.walk().find((e) => e.attrs.id === id) || null,
    querySelectorAll: () => [video],
  };
  const sandbox = { document, Number, Math, RegExp, setInterval: () => 1, addEventListener: () => {} };
  Object.defineProperty(sandbox, "location", { get: () => ({ pathname: "/watch/80100172" }) });
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(usSource, sandbox, { filename: usPath });
  const overlay = () => document.getElementById("sessao-a-dois-overlay").walk();
  return {
    button: (a) => overlay().find((e) => e.attrs["data-action"] === a),
    text: (r) => overlay().find((e) => e.attrs["data-role"] === r).textContent,
  };
}

test("userscript: Pause and +30 s exceptions show in the panel and later actions still work", async () => {
  const video = fakeVideo({ currentTime: 100 });
  const panel = loadUserscript(video);

  const workingPause = video.pause;
  video.pause = boom;
  panel.button("pause").click();
  assert.match(panel.text("message"), /Não foi possível pausar/);
  assert.match(panel.text("state"), /Título 80100172/, "painel continua atualizando");

  let writes = 0;
  Object.defineProperty(video, "currentTime", { get: () => 100, set: () => { writes += 1; throw new Error("seek recusado"); }, configurable: true });
  panel.button("seek").click();
  assert.equal(writes, 1);
  assert.match(panel.text("message"), /Não foi possível avançar 30 s/);

  video.pause = workingPause;
  panel.button("pause").click();
  assert.equal(video.pauseCalls, 1);
  assert.equal(panel.text("message"), "");

  Object.defineProperty(video, "currentTime", { value: 100, writable: true, configurable: true });
  panel.button("seek").click();
  assert.equal(video.currentTime, 130);
  panel.button("play").click();
  await new Promise((r) => setImmediate(r));
  assert.equal(video.playCalls, 1);
});

test("userscript: an exception while finding the video is reported, not thrown", () => {
  const video = fakeVideo();
  const panel = loadUserscript(video);
  video.getBoundingClientRect = boom;
  assert.doesNotThrow(() => panel.button("pause").click());
  assert.match(panel.text("message"), /Não foi possível executar a ação/);
});
