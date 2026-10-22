// Service worker (MV3). Só liga o hub puro ao chrome.runtime; sem armazenamento e sem rede.
importScripts("bridge-protocol.js", "hub.js");

const hub = self.DuoTelaBridgeHub.createHub({ runtimeId: chrome.runtime.id });
chrome.runtime.onConnect.addListener((port) => hub.onConnect(port));
