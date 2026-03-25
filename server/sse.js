'use strict';

const clients = new Map();

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function registerSseClient(key, res) {
  let set = clients.get(key);
  if (!set) {
    set = new Set();
    clients.set(key, set);
  }
  set.add(res);
}

function unregisterSseClient(key, res) {
  const set = clients.get(key);
  if (!set) return;
  set.delete(res);
  if (!set.size) clients.delete(key);
}

function broadcast(key, event, data) {
  const set = clients.get(key);
  if (!set) return;
  for (const res of set) {
    try {
      sendEvent(res, event, data);
    } catch (_) {}
  }
}

module.exports = {
  broadcast,
  registerSseClient,
  sendEvent,
  unregisterSseClient
};
