// Speaks text with a command-line TTS program, one message at a time.
// On Android that's `termux-tts-speak` (Termux:API), which uses the phone's own
// voice and keeps working while Chrome is minimized or closed.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export function findCommand(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/')) return isExecutable(cmd) ? cmd : null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    if (isExecutable(p)) return p;
  }
  return null;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Runs a command and resolves with { ok, out } — never rejects, never hangs past timeoutMs.
// (Termux:API commands hang forever when the Termux:API app is missing.)
export function probe(cmd, args, timeoutMs, spawnFn = spawn) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawnFn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ ok: false, out: '', timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, out, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, out, timedOut: false });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, timedOut: false });
    });
  });
}

export class CommandSpeaker extends EventEmitter {
  constructor({ cmd = 'termux-tts-speak', termuxArgs = true, getSettings = () => ({}), spawnFn = spawn } = {}) {
    super();
    this.cmd = cmd;
    this.termuxArgs = termuxArgs;
    this.getSettings = getSettings;
    this.spawnFn = spawnFn;
    this.queue = [];
    this.current = null;
    this.paused = false;
  }

  state() {
    return { type: 'queue', length: this.queue.length, paused: this.paused, speaking: Boolean(this.current) };
  }

  emitState() {
    this.emit('state', this.state());
  }

  // item: { fid, text, kind }. force: speak even while paused (the Test button).
  enqueue(item, { force = false } = {}) {
    if (this.paused && !force) {
      this.emit('tag', item.fid, 'skipped', 'paused');
      return;
    }
    const max = Math.max(1, Number(this.getSettings().maxQueue) || 10);
    while (this.queue.length >= max) {
      // Drop the oldest chat message first so gifts/follows still get read.
      let i = this.queue.findIndex((q) => q.kind === 'chat');
      if (i === -1) i = 0;
      const [dropped] = this.queue.splice(i, 1);
      this.emit('tag', dropped.fid, 'skipped', 'too busy');
    }
    this.queue.push({ ...item, force });
    this.emit('tag', item.fid, 'queued');
    this.emitState();
    this.pump();
  }

  args() {
    if (!this.termuxArgs) return [];
    const S = this.getSettings();
    const rate = Math.min(4, Math.max(0.1, Number(S.rate) || 1));
    const pitch = Math.min(4, Math.max(0.1, Number(S.pitch) || 1));
    // MUSIC stream = media volume, so it isn't silenced by notification/Do-not-disturb settings.
    const a = ['-s', 'MUSIC', '-r', String(rate), '-p', String(pitch)];
    const lang = String(S.phoneVoiceLang || '').trim();
    if (/^[a-z]{2,3}$/i.test(lang)) a.push('-l', lang.toLowerCase());
    return a;
  }

  pump() {
    if (this.current || !this.queue.length) return;
    if (this.paused && !this.queue[0].force) return;
    const item = this.queue.shift();
    let child;
    try {
      child = this.spawnFn(this.cmd, this.args(), { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (e) {
      this.emit('tag', item.fid, 'skipped', 'speech failed');
      this.emit('failure', e);
      setImmediate(() => this.pump());
      return;
    }
    const cur = { item, child, skipped: false, timer: null };
    this.current = cur;
    this.emit('tag', item.fid, 'speaking');
    this.emitState();

    const done = (state, reason) => {
      if (this.current !== cur) return;
      clearTimeout(cur.timer);
      this.current = null;
      this.emit('tag', item.fid, state, reason);
      this.emitState();
      setImmediate(() => this.pump());
    };
    child.on('error', (e) => {
      done('skipped', 'speech failed');
      this.emit('failure', e);
    });
    child.on('exit', (code) => {
      if (cur.skipped) done('skipped');
      else if (code === 0 || code === null) done('read');
      else done('skipped', 'speech failed');
    });
    const rate = Number(this.getSettings().rate) || 1;
    const expectMs = 4000 + (item.text.length / (13 * rate)) * 1000;
    cur.timer = setTimeout(() => {
      cur.skipped = true;
      child.kill('SIGKILL');
      done('skipped', 'stuck');
    }, expectMs + 20000);
    child.stdin?.on('error', () => {});
    child.stdin?.end(item.text.replace(/\s+/g, ' ') + '\n');
  }

  skip() {
    const cur = this.current;
    if (!cur) return;
    cur.skipped = true;
    cur.child.kill();
  }

  clear() {
    for (const q of this.queue) this.emit('tag', q.fid, 'skipped', 'cleared');
    this.queue = [];
    this.emitState();
  }

  setPaused(p) {
    this.paused = Boolean(p);
    if (this.paused) {
      this.clear();
      this.skip();
    }
    this.emitState();
    this.pump();
  }

  reset() {
    this.paused = false;
    this.clear();
    this.skip();
  }
}
