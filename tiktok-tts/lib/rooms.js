// One Room per TikTok username. A Room keeps a single connection to that LIVE
// and fans its events out to every open browser tab watching it. It never gives
// up: if you're not live yet, the LIVE ends, or TikTok drops the connection, it
// keeps retrying.
//
// Two modes:
//  - 'browser': the page decides what to say and speaks it. The room closes a
//    minute after the last tab leaves.
//  - 'server' (phone mode): the server decides and speaks through the phone's
//    voice (Termux). The room keeps running with no tab open at all, until
//    someone presses Stop, so minimizing or closing Chrome doesn't matter.
import { classifyError as defaultClassify } from './tiktok-source.js';
import '../public/brain.js';

const B = globalThis.TTSBrain;

export const DEFAULT_TIMING = {
  offlineRetryMs: 30_000, // not live yet / LIVE ended: check again this often
  rateLimitRetryMs: 60_000,
  dropRetryMs: 3_000, // TikTok dropped a working connection
  baseBackoffMs: 5_000, // other errors: 5s, 10s, 20s, 40s, 60s, 60s…
  maxBackoffMs: 60_000,
  connectTimeoutMs: 45_000,
};
const SEEN_LIMIT = 2000;

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error('Timed out connecting to TikTok')), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

export class Room {
  constructor(username, { createSource, classifyError = defaultClassify, log = console, timing = {}, manager = null }) {
    this.username = username;
    this.manager = manager;
    this.mode = 'browser';
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.createSource = createSource;
    this.classifyError = classifyError;
    this.log = log;
    this.clients = new Set();
    this.source = null;
    this.connecting = false;
    this.stopped = false;
    this.streamEnded = false;
    this.wasLive = false;
    this.failures = 0;
    this.timer = null;
    this.seen = new Set();
    this.status = { type: 'status', username, mode: 'browser', state: 'connecting', message: `Connecting to @${username}…`, viewers: null };
  }

  setMode(mode) {
    this.mode = mode;
    this.status = { ...this.status, mode };
  }

  add(client) {
    this.clients.add(client);
    send(client, this.status);
  }

  remove(client) {
    this.clients.delete(client);
  }

  start() {
    this.stopped = false;
    this.attempt();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const src = this.source;
    this.source = null;
    if (src) await src.disconnect();
  }

  setStatus(state, message, extra = {}) {
    this.status = { ...this.status, state, message, retryInSec: null, ...extra, at: Date.now() };
    this.broadcast(this.status);
    this.log.info?.(`[@${this.username}] ${state}: ${message}`);
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) send(c, data);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => this.attempt(), ms);
  }

  async attempt() {
    if (this.stopped || this.connecting) return;
    clearTimeout(this.timer);
    this.connecting = true;
    if (this.status.state !== 'offline') {
      this.setStatus(this.failures || this.wasLive ? 'reconnecting' : 'connecting', `Connecting to @${this.username}…`);
    }

    const src = this.createSource(this.username);
    this.source = src;
    src.on('event', (ev) => this.onEvent(src, ev));
    src.on('streamEnd', () => {
      if (src !== this.source) return;
      this.streamEnded = true;
    });
    src.on('disconnected', (reason) => {
      if (src !== this.source || this.connecting) return;
      this.onDrop(reason);
    });

    try {
      const { roomId } = await withTimeout(src.connect(), this.timing.connectTimeoutMs);
      this.connecting = false;
      if (this.stopped || src !== this.source) {
        await src.disconnect();
        return;
      }
      this.failures = 0;
      this.streamEnded = false;
      this.wasLive = true;
      this.setStatus('live', `Connected to @${this.username}'s LIVE`, { roomId });
    } catch (err) {
      this.connecting = false;
      if (src === this.source) this.source = null;
      await src.disconnect();
      if (this.stopped) return;
      this.failures += 1;
      const { kind, message } = this.classifyError(err);
      const T = this.timing;
      let delay;
      if (kind === 'offline') {
        delay = T.offlineRetryMs;
        this.setStatus('offline', `@${this.username} isn't live right now. Checking again every ${delay / 1000}s…`, { retryInSec: delay / 1000 });
      } else if (kind === 'ratelimit') {
        delay = T.rateLimitRetryMs;
        this.setStatus('error', `TikTok connection rate-limited. Trying again in ${delay / 1000}s…`, { retryInSec: delay / 1000, detail: message });
      } else {
        delay = Math.min(T.baseBackoffMs * 2 ** (this.failures - 1), T.maxBackoffMs);
        this.setStatus(
          'error',
          `Couldn't connect to @${this.username} (are you live and is the @ correct?). Retrying in ${Math.round(delay / 1000)}s…`,
          { retryInSec: Math.round(delay / 1000), detail: message },
        );
      }
      this.schedule(delay);
    }
  }

  async onDrop(reason) {
    if (this.stopped) return;
    const src = this.source;
    this.source = null;
    if (src) await src.disconnect();
    if (this.stopped) return;
    const T = this.timing;
    if (this.streamEnded) {
      this.setStatus('offline', `The LIVE ended. Waiting for @${this.username} to go live again…`, { retryInSec: T.offlineRetryMs / 1000 });
      this.schedule(T.offlineRetryMs);
    } else {
      this.setStatus('reconnecting', `TikTok dropped the connection${reason ? ` (${reason})` : ''}. Reconnecting…`, { retryInSec: T.dropRetryMs / 1000 });
      this.schedule(T.dropRetryMs);
    }
  }

  onEvent(src, ev) {
    if (src !== this.source || !ev || typeof ev.type !== 'string') return;
    if (ev.type === 'viewers') {
      this.status = { ...this.status, viewers: ev.count };
      this.broadcast(ev);
      return;
    }
    // TikTok sometimes delivers the same message twice (and again after a reconnect).
    if (ev.id) {
      const key = `${ev.type}:${ev.id}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value);
    }
    if (this.mode === 'server' && this.manager) {
      this.manager.serverEvent(this, ev);
      return;
    }
    this.broadcast({ ...ev, ts: Date.now() });
  }
}

export class RoomManager {
  constructor({
    createSource,
    classifyError,
    log = console,
    graceMs = 60_000,
    timing,
    speaker = null, // CommandSpeaker when the phone voice is available
    settings = {},
    onSettings = () => {},
    broadcastAll = () => {},
  }) {
    this.opts = { createSource, classifyError, log, timing, manager: this };
    this.graceMs = graceMs;
    this.rooms = new Map();
    this.clientRoom = new Map();
    this.stopTimers = new Map();
    this.settings = B.withDefaults(settings, settings.lang || 'en');
    this.onSettings = onSettings;
    this.broadcastAll = broadcastAll;
    this.mem = B.createMemory();
    this.fid = 0;
    this.speaker = null;
    if (speaker) this.setSpeaker(speaker);
  }

  setSpeaker(speaker) {
    this.speaker = speaker;
    speaker.on('tag', (fid, state, reason) => this.broadcastAll({ type: 'tag', fid, state, reason: reason || null }));
    speaker.on('state', (st) => this.broadcastAll(st));
  }

  join(client, username, mode = 'browser') {
    const current = this.clientRoom.get(client);
    if (current?.username === username) {
      this.setRoomMode(current, mode);
      send(client, current.status);
      return;
    }
    this.leave(client);
    const room = this.getOrCreate(username);
    this.setRoomMode(room, mode);
    room.add(client);
    this.clientRoom.set(client, room);
  }

  // Phone mode without any browser, e.g. `tts @name` in Termux.
  startPinned(username) {
    this.setRoomMode(this.getOrCreate(username), 'server');
  }

  getOrCreate(username) {
    let room = this.rooms.get(username);
    if (!room) {
      room = new Room(username, this.opts);
      this.rooms.set(username, room);
      room.start();
    }
    clearTimeout(this.stopTimers.get(username));
    this.stopTimers.delete(username);
    return room;
  }

  setRoomMode(room, mode) {
    if (mode === 'server' && !this.speaker) mode = 'browser';
    if (mode === 'server') {
      // Only one LIVE is read out loud on the phone at a time.
      for (const r of [...this.rooms.values()]) if (r !== room && r.mode === 'server') this.stopRoom(r.username);
    }
    if (room.mode !== mode) {
      room.setMode(mode);
      room.broadcast(room.status);
    }
  }

  stopRoom(username) {
    const room = this.rooms.get(username);
    if (!room) return;
    clearTimeout(this.stopTimers.get(username));
    this.stopTimers.delete(username);
    this.rooms.delete(username);
    for (const c of room.clients) this.clientRoom.delete(c);
    room.clients.clear();
    if (room.mode === 'server') this.speaker?.reset();
    room.stop();
    this.opts.log.info?.(`[@${username}] stopped`);
  }

  stopClientRoom(client) {
    const room = this.clientRoom.get(client);
    if (room) this.stopRoom(room.username);
  }

  activeRooms() {
    return [...this.rooms.values()].filter((r) => r.mode === 'server').map((r) => ({ username: r.username, mode: r.mode }));
  }

  updateSettings(partial) {
    this.settings = { ...this.settings, ...B.sanitize(partial) };
    this.onSettings(this.settings);
  }

  // Phone mode: decide here, show the result in every open tab, speak it on the phone.
  serverEvent(room, ev) {
    const d = B.decide(ev, this.settings, this.mem);
    if (!d) return;
    const fid = ++this.fid;
    room.broadcast({
      ...ev,
      ts: Date.now(),
      fid,
      feed: { kind: d.kind, who: d.who, what: d.what },
      tag: d.speak ? { state: 'queued' } : { state: 'skipped', reason: d.reason },
    });
    if (d.speak) this.speaker.enqueue({ fid, text: d.speak, kind: d.kind });
  }

  control(action, text) {
    const sp = this.speaker;
    if (!sp) return;
    if (action === 'pause') sp.setPaused(true);
    else if (action === 'resume') sp.setPaused(false);
    else if (action === 'skip') sp.skip();
    else if (action === 'clear') sp.clear();
    else if (action === 'test') {
      const raw = String(text || '').slice(0, 300);
      const fid = ++this.fid;
      this.broadcastAll({ type: 'test', fid, feed: { kind: 'chat', who: 'Test', what: raw }, tag: { state: 'queued' } });
      sp.enqueue({ fid, text: B.cleanText(raw, this.settings) || 'Hello', kind: 'test' }, { force: true });
    }
  }

  leave(client) {
    const room = this.clientRoom.get(client);
    if (!room) return;
    this.clientRoom.delete(client);
    room.remove(client);
    if (room.clients.size > 0 || room.mode === 'server') return;
    // Keep the TikTok connection for a bit so a page reload doesn't drop it.
    clearTimeout(this.stopTimers.get(room.username));
    this.stopTimers.set(
      room.username,
      setTimeout(() => {
        this.stopTimers.delete(room.username);
        if (room.clients.size > 0 || room.mode === 'server' || this.rooms.get(room.username) !== room) return;
        this.rooms.delete(room.username);
        room.stop();
        this.opts.log.info?.(`[@${room.username}] no tabs open, disconnected`);
      }, this.graceMs),
    );
  }

  async closeAll() {
    for (const t of this.stopTimers.values()) clearTimeout(t);
    this.speaker?.reset();
    await Promise.all([...this.rooms.values()].map((r) => r.stop()));
    this.rooms.clear();
  }
}

function send(client, msg) {
  if (client.readyState !== 1) return; // 1 = OPEN
  try {
    client.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  } catch {
    // socket is closing
  }
}
