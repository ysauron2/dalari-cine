"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const spikeRoot = path.join(__dirname, "..");
const {
  MESSAGE_TYPES, ERROR_CODES, createVideoController, createDomVideoFinder,
  validateSeekSeconds, readVideoIdFromLocation,
} = require("../src/video-controller.js");
const { formatClock, describeResponse, parseSecondsInput } = require("../popup/popup-model.js");

function domError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

function createFakeVideo(overrides = {}) {
  const video = {
    paused: true, ended: false, currentTime: 10, duration: 120, readyState: 4,
    playCalls: 0, pauseCalls: 0, playBehavior: () => Promise.resolve(),
    play() { this.playCalls += 1; return this.playBehavior().then(() => { this.paused = false; }); },
    pause() { this.pauseCalls += 1; this.paused = true; },
    ...overrides,
  };
  return video;
}

function createController(video, href = "https://www.youtube.com/watch?v=abc123") {
  const holder = { video, href };
  const controller = createVideoController({
    findCurrentVideo: () => holder.video,
    getLocation: () => ({ href: holder.href }),
  });
  return { controller, holder };
}

test("GET_STATE reports the current video state", async () => {
  const { controller } = createController(createFakeVideo({ paused: false, currentTime: 33.5 }));
  const response = await controller.handleMessage({ type: MESSAGE_TYPES.GET_STATE });
  assert.equal(response.ok, true);
  assert.deepEqual(response.state, {
    hasVideo: true, videoId: "abc123", isPlaying: true, isEnded: false,
    currentTimeSeconds: 33.5, durationSeconds: 120, readyState: 4,
  });
});

test("GET_STATE with no video succeeds with hasVideo false; actions fail with NO_VIDEO", async () => {
  const { controller } = createController(null, "https://www.youtube.com/");
  const state = await controller.handleMessage({ type: "GET_STATE" });
  assert.equal(state.ok, true);
  assert.equal(state.state.hasVideo, false);
  assert.equal(state.state.videoId, null);
  for (const message of [{ type: "PLAY" }, { type: "PAUSE" }, { type: "SEEK_TO_SECONDS", seconds: 5 }]) {
    const response = await controller.handleMessage(message);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, ERROR_CODES.NO_VIDEO);
  }
});

test("GET_STATE maps non-finite duration (live/loading) to null", async () => {
  const { controller } = createController(createFakeVideo({ duration: Infinity, currentTime: NaN }));
  const { state } = await controller.handleMessage({ type: "GET_STATE" });
  assert.equal(state.durationSeconds, null);
  assert.equal(state.currentTimeSeconds, null);
});

test("PLAY starts playback and PAUSE stops it", async () => {
  const video = createFakeVideo();
  const { controller } = createController(video);
  const played = await controller.handleMessage({ type: "PLAY" });
  assert.equal(played.ok, true);
  assert.equal(played.state.isPlaying, true);
  const paused = await controller.handleMessage({ type: "PAUSE" });
  assert.equal(paused.ok, true);
  assert.equal(paused.state.isPlaying, false);
  assert.equal(video.playCalls, 1);
  assert.equal(video.pauseCalls, 1);
});

test("PLAY reports autoplay/user-gesture block, interruption and generic failure", async () => {
  const cases = [
    ["NotAllowedError", ERROR_CODES.PLAY_BLOCKED_BY_BROWSER],
    ["AbortError", ERROR_CODES.PLAY_INTERRUPTED],
    ["NotSupportedError", ERROR_CODES.PLAY_FAILED],
  ];
  for (const [errorName, expectedCode] of cases) {
    const video = createFakeVideo({ playBehavior: () => Promise.reject(domError(errorName)) });
    const { controller } = createController(video);
    const response = await controller.handleMessage({ type: "PLAY" });
    assert.equal(response.ok, false, errorName);
    assert.equal(response.error.code, expectedCode);
    assert.equal(response.state.isPlaying, false);
  }
});

test("PLAY handles a synchronous throw and a play() that returns undefined", async () => {
  const throwing = createFakeVideo({ play() { throw domError("NotAllowedError"); } });
  const blocked = await createController(throwing).controller.handleMessage({ type: "PLAY" });
  assert.equal(blocked.error.code, ERROR_CODES.PLAY_BLOCKED_BY_BROWSER);

  const legacy = createFakeVideo({ play() { this.paused = false; } });
  const ok = await createController(legacy).controller.handleMessage({ type: "PLAY" });
  assert.equal(ok.ok, true);
  assert.equal(ok.state.isPlaying, true);
});

test("SEEK_TO_SECONDS seeks and clamps to the duration", async () => {
  const video = createFakeVideo();
  const { controller } = createController(video);
  const inRange = await controller.handleMessage({ type: "SEEK_TO_SECONDS", seconds: 42.5 });
  assert.equal(inRange.ok, true);
  assert.equal(video.currentTime, 42.5);
  const beyond = await controller.handleMessage({ type: "SEEK_TO_SECONDS", seconds: 99999 });
  assert.equal(beyond.ok, true);
  assert.equal(video.currentTime, 120);
  const zero = await controller.handleMessage({ type: "SEEK_TO_SECONDS", seconds: 0 });
  assert.equal(zero.ok, true);
  assert.equal(video.currentTime, 0);
});

test("SEEK_TO_SECONDS rejects untrusted input without touching currentTime", async () => {
  const video = createFakeVideo({ currentTime: 7 });
  const { controller } = createController(video);
  const hostile = [
    "30", "", null, undefined, NaN, Infinity, -Infinity, -1, -0.001,
    {}, [], [5], true, 10n, { valueOf: () => 5 }, () => 5,
  ];
  for (const seconds of hostile) {
    const response = await controller.handleMessage({ type: "SEEK_TO_SECONDS", seconds });
    assert.equal(response.ok, false, String(typeof seconds));
    assert.equal(response.error.code, ERROR_CODES.INVALID_SEEK_SECONDS);
  }
  const missing = await controller.handleMessage({ type: "SEEK_TO_SECONDS" });
  assert.equal(missing.error.code, ERROR_CODES.INVALID_SEEK_SECONDS);
  assert.equal(video.currentTime, 7);
});

test("SEEK_TO_SECONDS refuses when duration is unknown (live or not loaded)", async () => {
  for (const duration of [Infinity, NaN, 0]) {
    const video = createFakeVideo({ duration, currentTime: 3 });
    const response = await createController(video).controller.handleMessage({ type: "SEEK_TO_SECONDS", seconds: 5 });
    assert.equal(response.error.code, ERROR_CODES.DURATION_UNKNOWN);
    assert.equal(video.currentTime, 3);
  }
});

test("validateSeekSeconds is pure and exact", () => {
  assert.deepEqual(validateSeekSeconds(5, 10), { ok: true, seconds: 5 });
  assert.deepEqual(validateSeekSeconds(50, 10), { ok: true, seconds: 10 });
  assert.equal(validateSeekSeconds("5", 10).code, ERROR_CODES.INVALID_SEEK_SECONDS);
});

test("invalid and unknown messages are rejected without side effects", async () => {
  const video = createFakeVideo();
  const { controller } = createController(video);
  for (const message of [null, undefined, "PLAY", 5, [], {}, { type: 1 }]) {
    const response = await controller.handleMessage(message);
    assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
  }
  for (const type of ["play", "DELETE_EVERYTHING", "__proto__", "toString", "constructor"]) {
    const response = await controller.handleMessage({ type });
    assert.equal(response.error.code, ERROR_CODES.UNKNOWN_MESSAGE_TYPE, type);
  }
  assert.equal(video.playCalls + video.pauseCalls, 0);
});

test("SPA navigation: new video element and URL are picked up without reload", async () => {
  const firstVideo = createFakeVideo({ currentTime: 1 });
  const { controller, holder } = createController(firstVideo, "https://www.youtube.com/watch?v=first");
  assert.equal((await controller.handleMessage({ type: "GET_STATE" })).state.videoId, "first");

  holder.video = null; // YouTube remove o player durante a transicao
  holder.href = "https://www.youtube.com/";
  const midNavigation = await controller.handleMessage({ type: "GET_STATE" });
  assert.equal(midNavigation.state.hasVideo, false);

  const secondVideo = createFakeVideo({ currentTime: 50 });
  holder.video = secondVideo;
  holder.href = "https://www.youtube.com/watch?v=second";
  await controller.handleMessage({ type: "PAUSE" });
  const after = await controller.handleMessage({ type: "GET_STATE" });
  assert.equal(after.state.videoId, "second");
  assert.equal(after.state.currentTimeSeconds, 50);
  assert.equal(secondVideo.pauseCalls, 1);
  assert.equal(firstVideo.pauseCalls, 0);
});

test("readVideoIdFromLocation handles watch, shorts, home and garbage", () => {
  assert.equal(readVideoIdFromLocation({ href: "https://m.youtube.com/watch?v=xyz&t=5" }), "xyz");
  assert.equal(readVideoIdFromLocation({ href: "https://www.youtube.com/shorts/ab_-1" }), "ab_-1");
  assert.equal(readVideoIdFromLocation({ href: "https://www.youtube.com/" }), null);
  assert.equal(readVideoIdFromLocation({ href: "not a url" }), null);
  assert.equal(readVideoIdFromLocation(null), null);
});

test("createDomVideoFinder prefers the main player over other videos", () => {
  const mainVideo = { name: "main" };
  const previewVideo = { name: "preview" };
  const fakeDocument = {
    querySelector(selector) {
      if (selector === "#movie_player video.html5-main-video") return mainVideo;
      if (selector === "video") return previewVideo;
      return null;
    },
  };
  assert.equal(createDomVideoFinder(fakeDocument)(), mainVideo);
  const onlyPreview = { querySelector: (selector) => (selector === "video" ? previewVideo : null) };
  assert.equal(createDomVideoFinder(onlyPreview)(), previewVideo);
  assert.equal(createDomVideoFinder({ querySelector: () => null })(), null);
});

test("createVideoController requires findCurrentVideo", () => {
  assert.throws(() => createVideoController({}), TypeError);
});

function runContentScript({ senderId }) {
  let registeredListener = null;
  const video = createFakeVideo();
  const extensionApi = { runtime: { id: "my-extension", onMessage: { addListener: (fn) => { registeredListener = fn; } } } };
  const sandbox = {
    chrome: extensionApi,
    document: { querySelector: () => video },
    window: { location: { href: "https://www.youtube.com/watch?v=abc" } },
    URL,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ["src/video-controller.js", "src/content-script.js"]) {
    vm.runInContext(fs.readFileSync(path.join(spikeRoot, file), "utf8"), sandbox, { filename: file });
  }
  return new Promise((resolve) => {
    const keptChannelOpen = registeredListener({ type: "GET_STATE" }, { id: senderId }, resolve);
    if (keptChannelOpen === false) resolve("IGNORED");
  });
}

test("content script answers its own extension and ignores other senders", async () => {
  const own = await runContentScript({ senderId: "my-extension" });
  assert.equal(own.ok, true);
  assert.equal(own.state.videoId, "abc");
  assert.equal(await runContentScript({ senderId: "someone-else" }), "IGNORED");
  assert.equal(await runContentScript({ senderId: undefined }), "IGNORED");
});

test("manifest: MV3, YouTube and Netflix watch routes, zero permissions, no network or storage surface", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(spikeRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, []);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.content_scripts.length, 2);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://www.youtube.com/*", "https://m.youtube.com/*"]);
  assert.deepEqual(manifest.content_scripts[1].matches, ["https://www.netflix.com/watch/*"]);
  for (const entry of manifest.content_scripts) {
    assert.equal(entry.all_frames, false);
    for (const file of entry.js) assert.ok(fs.existsSync(path.join(spikeRoot, file)), `missing ${file}`);
  }
  assert.ok(fs.existsSync(path.join(spikeRoot, manifest.action.default_popup)));
});

test("source files contain no network, storage, dynamic-code or remote-script APIs", () => {
  const sourceFiles = ["src/video-controller.js", "src/content-script.js", "popup/popup.js", "popup/popup-model.js", "popup/popup.html"];
  const forbidden = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|eval|importScripts)\b|new Function|\.storage\b|https?:\/\/(?!www\.youtube\.com|m\.youtube\.com)/;
  for (const file of sourceFiles) {
    const text = fs.readFileSync(path.join(spikeRoot, file), "utf8");
    const executable = text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    assert.doesNotMatch(executable, forbidden, file);
  }
});

test("popup model formats state, errors and seek input", () => {
  assert.equal(formatClock(75), "1:15");
  assert.equal(formatClock(3725), "1:02:05");
  assert.equal(formatClock(null), "--:--");
  assert.equal(formatClock(-3), "--:--");
  assert.match(describeResponse(null), /Sem resposta/);
  assert.equal(
    describeResponse({ ok: true, state: { hasVideo: true, videoId: "abc", isPlaying: true, isEnded: false, currentTimeSeconds: 5, durationSeconds: 60 } }),
    "Video abc: tocando, 0:05 / 1:00",
  );
  assert.match(describeResponse({ ok: true, state: { hasVideo: false } }), /Nenhum video/);
  const blocked = describeResponse({
    ok: false, error: { code: "PLAY_BLOCKED_BY_BROWSER", message: "bloqueado" },
    state: { hasVideo: true, videoId: null, isPlaying: false, isEnded: false, currentTimeSeconds: 0, durationSeconds: 60 },
  });
  assert.match(blocked, /PLAY_BLOCKED_BY_BROWSER/);
  assert.match(blocked, /id desconhecido/);
  assert.equal(parseSecondsInput(" 90 "), 90);
  assert.equal(parseSecondsInput("12.5"), 12.5);
  for (const bad of ["", "abc", "-5", "1e3", "0x10", "5 6", "Infinity"]) {
    assert.ok(Number.isNaN(parseSecondsInput(bad)), bad);
  }
});
