import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomManager } from '../lib/rooms.js';
import { CommandSpeaker, probe } from '../lib/speaker.js';
import '../public/brain.js';

const B = globalThis.TTSBrain;
const quiet = { info() {}, warn() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake `termux-tts-speak`: records what it was asked to say, "speaks" for `ms`.
function fakeSpawn(spoken, ms = 15) {
  const calls = [];
  const fn = (cmd, args) => {
    const child = new EventEmitter();
    calls.push({ cmd, args });
    let text = '';
    child.stdin = { on() {}, end: (t) => (text = t) };
    child.kill = () => setImmediate(() => child.emit('exit', null));
    setTimeout(() => {
      spoken.push(text.trim());
      child.emit('exit', 0);
    }, ms);
    return child;
  };
  fn.calls = calls;
  return fn;
}

class FakeClient {
  constructor() {
    this.readyState = 1;
    this.msgs = [];
  }
  send(d) {
    this.msgs.push(JSON.parse(d));
  }
}

function fakeSources() {
  const made = [];
  const create = () => {
    const src = new EventEmitter();
    src.connect = async () => ({ roomId: '1' });
    src.disconnected = false;
    src.disconnect = async () => {
      src.disconnected = true;
    };
    made.push(src);
    return src;
  };
  return { create, made };
}

const chat = (id, nickname, text, extra = {}) => ({ type: 'chat', id, user: { uniqueId: nickname.toLowerCase(), nickname }, text, ...extra });

test('brain: filters and wording', () => {
  const S = B.withDefaults({}, 'en');
  const mem = B.createMemory();
  assert.equal(B.decide(chat('1', 'Mila', 'hello there'), S, mem).speak, 'Mila says hello there');
  assert.equal(B.decide(chat('2', 'Mila', '!points'), S, mem).reason, 'command');
  assert.equal(B.decide(chat('3', 'Mila', 'hello there'), S, mem).reason, 'repeat');
  assert.equal(B.decide(chat('4', 'Tom', 'see https://x.com 😂😂 loooool'), S, mem).speak, 'Tom says see lool');
  assert.equal(B.decide({ type: 'gift', user: { nickname: 'Ana' }, gift: 'Rose', count: 3, coins: 3 }, S, mem).speak, 'Ana sent 3 Roses');
  assert.equal(B.decide({ type: 'join', user: { nickname: 'Ana' } }, S, mem), null);
  const mods = { ...S, who: 'mods' };
  assert.equal(B.decide(chat('5', 'Zed', 'hi'), mods, mem).reason, 'not allowed');
  assert.equal(B.decide(chat('6', 'Zed', 'hi mod', { isMod: true }), mods, mem).speak, 'Zed says hi mod');
});

test('brain: Bulgarian wording, including old saved English defaults', () => {
  const S = B.withDefaults({ chatTemplate: '{name} says {text}', rate: 1.5 }, 'bg-BG');
  assert.equal(S.chatTemplate, '{name} казва {text}');
  assert.equal(S.rate, 1.5);
  assert.equal(S.phoneVoiceLang, 'bg');
  assert.equal(B.decide(chat('1', 'Мила', 'здрасти'), S, B.createMemory()).speak, 'Мила казва здрасти');
  const custom = B.withDefaults({ chatTemplate: '{name}: {text}' }, 'bg');
  assert.equal(custom.chatTemplate, '{name}: {text}');
});

test('brain: sanitize drops unknown keys and wrong types', () => {
  const s = B.sanitize({ rate: '9', readChat: false, __proto__polluted: 1, chatTemplate: 'x', nope: 1 });
  assert.deepEqual(s, { readChat: false, chatTemplate: 'x' });
});

test('speaker: one at a time, termux args, drops oldest chat when too busy', async () => {
  const spoken = [];
  const spawnFn = fakeSpawn(spoken);
  const settings = { rate: 1.25, pitch: 1, phoneVoiceLang: 'bg', maxQueue: 2 };
  const sp = new CommandSpeaker({ spawnFn, getSettings: () => settings });
  const tags = [];
  sp.on('tag', (fid, state, reason) => tags.push([fid, state, reason]));
  sp.enqueue({ fid: 1, text: 'one', kind: 'chat' });
  sp.enqueue({ fid: 2, text: 'two', kind: 'chat' });
  sp.enqueue({ fid: 3, text: 'gift', kind: 'gift' });
  sp.enqueue({ fid: 4, text: 'four', kind: 'chat' }); // queue full (2): drops "two"
  await sleep(150);
  assert.deepEqual(spoken, ['one', 'gift', 'four']);
  assert.ok(tags.some(([f, s, r]) => f === 2 && s === 'skipped' && r === 'too busy'));
  assert.deepEqual(spawnFn.calls[0].args, ['-s', 'MUSIC', '-r', '1.25', '-p', '1', '-l', 'bg']);
});

test('speaker: pause skips new messages, test button still speaks', async () => {
  const spoken = [];
  const sp = new CommandSpeaker({ spawnFn: fakeSpawn(spoken), getSettings: () => ({}) });
  sp.setPaused(true);
  sp.enqueue({ fid: 1, text: 'ignored', kind: 'chat' });
  sp.enqueue({ fid: 2, text: 'test', kind: 'test' }, { force: true });
  await sleep(60);
  assert.deepEqual(spoken, ['test']);
  sp.setPaused(false);
  sp.enqueue({ fid: 3, text: 'back', kind: 'chat' });
  await sleep(60);
  assert.deepEqual(spoken, ['test', 'back']);
});

test('probe gives up on a command that hangs (missing Termux:API app)', async () => {
  const t = Date.now();
  const r = await probe('sleep', ['5'], 200);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t < 2000);
  assert.equal((await probe('true', [], 2000)).ok, true);
});

test('phone mode keeps reading after the browser tab is gone, until Stop', async () => {
  const spoken = [];
  const { create, made } = fakeSources();
  const all = [];
  const mgr = new RoomManager({ createSource: create, log: quiet, graceMs: 20, settings: { lang: 'en' }, broadcastAll: (m) => all.push(m) });
  mgr.setSpeaker(new CommandSpeaker({ spawnFn: fakeSpawn(spoken), getSettings: () => mgr.settings }));
  const tab = new FakeClient();
  mgr.join(tab, 'me', 'server');
  await sleep(10);
  made[0].emit('event', chat('a', 'Mila', 'first'));
  await sleep(40);
  // Chrome gets closed / killed:
  mgr.leave(tab);
  await sleep(60); // longer than graceMs
  assert.equal(made[0].disconnected, false);
  made[0].emit('event', chat('b', 'Tom', 'second'));
  made[0].emit('event', chat('c', 'Tom', '!cmd'));
  await sleep(60);
  assert.deepEqual(spoken, ['Mila says first', 'Tom says second']);
  assert.deepEqual(mgr.activeRooms(), [{ username: 'me', mode: 'server' }]);
  // The tab sees decided events with feed + tag info, and tag updates.
  const feed = tab.msgs.find((m) => m.type === 'chat');
  assert.deepEqual(feed.feed, { kind: 'chat', who: 'Mila', what: 'first' });
  assert.ok(all.some((m) => m.type === 'tag' && m.state === 'read'));
  // Reopen the page and press Stop.
  const tab2 = new FakeClient();
  mgr.join(tab2, 'me', 'server');
  mgr.stopClientRoom(tab2);
  await sleep(10);
  assert.equal(made[0].disconnected, true);
  assert.deepEqual(mgr.activeRooms(), []);
});

test('phone mode falls back to browser mode when there is no phone voice', () => {
  const { create } = fakeSources();
  const mgr = new RoomManager({ createSource: create, log: quiet });
  const tab = new FakeClient();
  mgr.join(tab, 'me', 'server');
  assert.equal(mgr.rooms.get('me').mode, 'browser');
  mgr.stopRoom('me');
});

test('settings from the page are sanitized and saved', () => {
  const saved = [];
  const { create } = fakeSources();
  const mgr = new RoomManager({ createSource: create, log: quiet, onSettings: (s) => saved.push(s) });
  mgr.updateSettings({ rate: 1.5, evil: 'x', readChat: 'yes' });
  assert.equal(mgr.settings.rate, 1.5);
  assert.equal(mgr.settings.readChat, true);
  assert.equal('evil' in mgr.settings, false);
  assert.equal(saved.length, 1);
});
