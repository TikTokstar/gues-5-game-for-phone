import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Room, RoomManager } from '../lib/rooms.js';
import { normalizeUsername } from '../lib/username.js';

const FAST = { offlineRetryMs: 30, rateLimitRetryMs: 30, dropRetryMs: 20, baseBackoffMs: 10, maxBackoffMs: 40, connectTimeoutMs: 200 };
const quiet = { info() {}, warn() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeClient {
  constructor() {
    this.readyState = 1;
    this.msgs = [];
  }
  send(data) {
    this.msgs.push(JSON.parse(data));
  }
  states() {
    return this.msgs.filter((m) => m.type === 'status').map((m) => m.state);
  }
}

// A source whose connect() outcomes are scripted: 'ok', 'offline', 'error'.
function scriptedSources(script) {
  const made = [];
  const create = () => {
    const src = new EventEmitter();
    const outcome = script.length ? script.shift() : 'ok';
    src.connect = async () => {
      await sleep(1);
      if (outcome === 'offline') throw new Error("The requested user isn't online :(");
      if (outcome === 'error') throw new Error('Failed to retrieve Room ID from all sources.');
      return { roomId: '123' };
    };
    src.disconnected = false;
    src.disconnect = async () => {
      src.disconnected = true;
    };
    made.push(src);
    return src;
  };
  return { create, made };
}

test('normalizeUsername accepts @, plain names and links', () => {
  assert.equal(normalizeUsername('@Some.User_1'), 'some.user_1');
  assert.equal(normalizeUsername('  someuser '), 'someuser');
  assert.equal(normalizeUsername('https://www.tiktok.com/@cool_streamer/live'), 'cool_streamer');
  assert.equal(normalizeUsername('bad name!'), null);
  assert.equal(normalizeUsername(''), null);
  assert.equal(normalizeUsername('a'.repeat(25)), null);
});

test('keeps retrying while offline, then goes live', async () => {
  const { create, made } = scriptedSources(['offline', 'offline', 'ok']);
  const room = new Room('me', { createSource: create, log: quiet, timing: FAST });
  const c = new FakeClient();
  room.add(c);
  room.start();
  await sleep(150);
  assert.equal(made.length, 3);
  assert.deepEqual(c.states().filter((s) => s !== 'connecting'), ['offline', 'offline', 'live']);
  await room.stop();
});

test('backs off on errors and recovers', async () => {
  const { create, made } = scriptedSources(['error', 'error', 'ok']);
  const room = new Room('me', { createSource: create, log: quiet, timing: FAST });
  const c = new FakeClient();
  room.add(c);
  room.start();
  await sleep(150);
  assert.equal(made.length, 3);
  assert.equal(c.states().at(-1), 'live');
  assert.ok(c.states().includes('error'));
  await room.stop();
});

test('reconnects after TikTok drops the connection, forwards events, drops duplicates', async () => {
  const { create, made } = scriptedSources(['ok', 'ok']);
  const room = new Room('me', { createSource: create, log: quiet, timing: FAST });
  const c = new FakeClient();
  room.add(c);
  room.start();
  await sleep(20);
  const chat = { type: 'chat', id: 'm1', user: { uniqueId: 'a', nickname: 'A' }, text: 'hi' };
  made[0].emit('event', chat);
  made[0].emit('event', chat); // duplicate
  made[0].emit('disconnected', 'network');
  await sleep(80);
  assert.equal(made.length, 2);
  assert.ok(made[0].disconnected);
  // Events from the old, dead source are ignored; the new one works; duplicates across reconnects are dropped.
  made[0].emit('event', { ...chat, id: 'old' });
  made[1].emit('event', chat);
  made[1].emit('event', { ...chat, id: 'm2', text: 'again' });
  const chats = c.msgs.filter((m) => m.type === 'chat').map((m) => m.text);
  assert.deepEqual(chats, ['hi', 'again']);
  assert.deepEqual(c.states().slice(-2), ['reconnecting', 'live']);
  await room.stop();
});

test('stream end waits for the next LIVE instead of hammering', async () => {
  const { create, made } = scriptedSources(['ok', 'offline', 'ok']);
  const room = new Room('me', { createSource: create, log: quiet, timing: FAST });
  const c = new FakeClient();
  room.add(c);
  room.start();
  await sleep(20);
  made[0].emit('streamEnd');
  made[0].emit('disconnected', '');
  await sleep(10);
  assert.equal(c.states().at(-1), 'offline');
  await sleep(150);
  assert.equal(c.states().at(-1), 'live');
  await room.stop();
});

test('a hung connect times out and is retried', async () => {
  let n = 0;
  const create = () => {
    const src = new EventEmitter();
    const i = n++;
    src.connect = () => (i === 0 ? new Promise(() => {}) : Promise.resolve({ roomId: '1' }));
    src.disconnect = async () => {};
    return src;
  };
  const room = new Room('me', { createSource: create, log: quiet, timing: FAST });
  const c = new FakeClient();
  room.add(c);
  room.start();
  await sleep(320);
  assert.equal(c.states().at(-1), 'live');
  await room.stop();
});

test('manager shares one TikTok connection per username and closes it after the last tab leaves', async () => {
  const { create, made } = scriptedSources([]);
  const mgr = new RoomManager({ createSource: create, log: quiet, timing: FAST, graceMs: 30 });
  const a = new FakeClient();
  const b = new FakeClient();
  mgr.join(a, 'me');
  mgr.join(b, 'me');
  await sleep(20);
  assert.equal(made.length, 1);
  made[0].emit('event', { type: 'chat', id: 'x', user: {}, text: 'yo' });
  assert.equal(a.msgs.filter((m) => m.type === 'chat').length, 1);
  assert.equal(b.msgs.filter((m) => m.type === 'chat').length, 1);
  mgr.leave(a);
  mgr.leave(b);
  // Re-joining within the grace period keeps the same connection (page reload).
  mgr.join(a, 'me');
  await sleep(50);
  assert.equal(made.length, 1);
  assert.equal(made[0].disconnected, false);
  mgr.leave(a);
  await sleep(60);
  assert.equal(made[0].disconnected, true);
  assert.equal(mgr.rooms.size, 0);
});
