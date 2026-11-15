// One Room per TikTok username. A Room keeps a single connection to that LIVE
// and fans its events out to every open browser tab watching it. It never gives
// up: if you're not live yet, the LIVE ends, or TikTok drops the connection, it
// keeps retrying until the last browser tab leaves.
import { classifyError as defaultClassify } from './tiktok-source.js';

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
  constructor(username, { createSource, classifyError = defaultClassify, log = console, timing = {} }) {
    this.username = username;
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
    this.status = { type: 'status', username, state: 'connecting', message: `Connecting to @${username}…`, viewers: null };
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
    this.broadcast({ ...ev, ts: Date.now() });
  }
}

export class RoomManager {
  constructor({ createSource, classifyError, log = console, graceMs = 60_000, timing }) {
    this.opts = { createSource, classifyError, log, timing };
    this.graceMs = graceMs;
    this.rooms = new Map();
    this.clientRoom = new Map();
    this.stopTimers = new Map();
  }

  join(client, username) {
    if (this.clientRoom.get(client)?.username === username) {
      send(client, this.clientRoom.get(client).status);
      return;
    }
    this.leave(client);
    let room = this.rooms.get(username);
    if (!room) {
      room = new Room(username, this.opts);
      this.rooms.set(username, room);
      room.start();
    }
    clearTimeout(this.stopTimers.get(username));
    this.stopTimers.delete(username);
    room.add(client);
    this.clientRoom.set(client, room);
  }

  leave(client) {
    const room = this.clientRoom.get(client);
    if (!room) return;
    this.clientRoom.delete(client);
    room.remove(client);
    if (room.clients.size > 0) return;
    // Keep the TikTok connection for a bit so a page reload doesn't drop it.
    clearTimeout(this.stopTimers.get(room.username));
    this.stopTimers.set(
      room.username,
      setTimeout(() => {
        this.stopTimers.delete(room.username);
        if (room.clients.size > 0) return;
        this.rooms.delete(room.username);
        room.stop();
        this.opts.log.info?.(`[@${room.username}] no tabs open, disconnected`);
      }, this.graceMs),
    );
  }

  async closeAll() {
    for (const t of this.stopTimers.values()) clearTimeout(t);
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
