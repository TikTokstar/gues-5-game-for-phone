// TikTok LIVE TTS server.
//   npm start            -> serves the page on http://localhost:3000 and opens it
//   npm run demo         -> same, but with a fake LIVE so you can test without streaming
//   node server.js --user NAME
//                        -> on Android/Termux: start reading @NAME with the phone's
//                           voice right away, no browser needed
//
// The browser page only sends your @username; this server does the TikTok part
// (browsers can't talk to TikTok's live chat directly) and streams the chat back.
// On Android (Termux) the server can also do the talking itself, through the
// phone's own voice, so it keeps reading while Chrome is minimized or closed.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { RoomManager } from './lib/rooms.js';
import { normalizeUsername } from './lib/username.js';
import { TikTokSource, classifyError } from './lib/tiktok-source.js';
import { DemoSource } from './lib/demo-source.js';
import { CommandSpeaker, findCommand, probe } from './lib/speaker.js';

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const DEMO = args.includes('--demo') || process.env.TTS_DEMO === '1';
const OPEN = args.includes('--open') && !process.env.NO_OPEN;
const CLI_USER = argValue('--user');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const IS_TERMUX = Boolean(process.env.TERMUX_VERSION) || (process.env.PREFIX || '').includes('com.termux');
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const SETTINGS_FILE = process.env.TTS_SETTINGS_FILE || path.join(APP_DIR, 'settings.json');

// ---------------------------------------------------------------- settings (remembered between runs)
function loadSavedSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
let saveTimer = null;
function saveSettingsSoon(settings) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), () => {});
  }, 500);
}

// ---------------------------------------------------------------- phone voice (Termux)
const SPEAK_CMD = process.env.TTS_SPEAK_CMD || (IS_TERMUX ? 'termux-tts-speak' : null);
const speech = {
  type: 'speaker',
  available: false,
  checking: Boolean(SPEAK_CMD),
  why: SPEAK_CMD ? 'Checking the phone voice…' : 'Only on Android (Termux).',
};

async function checkPhoneVoice() {
  if (!SPEAK_CMD) return;
  const cmdPath = findCommand(SPEAK_CMD);
  if (!cmdPath) {
    setSpeech(false, IS_TERMUX ? 'Phone voice not installed. In Termux run:  tts update' : `Speech command not found: ${SPEAK_CMD}`);
    return;
  }
  if (!process.env.TTS_SPEAK_CMD) {
    // termux-tts-engines answers quickly when the Termux:API app works, and hangs when it's missing.
    const r = await probe('termux-tts-engines', [], 12_000);
    if (!r.ok) {
      setSpeech(
        false,
        'The Termux:API app is not responding. Install the "Termux:API" app (from the same store as Termux), ' +
          'then in Settings → Apps → Termux:API turn on Autostart and set Battery saver to No restrictions.',
      );
      return;
    }
  }
  setSpeech(true, 'Ready');
  manager.setSpeaker(
    new CommandSpeaker({
      cmd: cmdPath,
      termuxArgs: !process.env.TTS_SPEAK_CMD,
      getSettings: () => manager.settings,
    }),
  );
  broadcastAll(manager.speaker.state());
}

function setSpeech(available, why) {
  Object.assign(speech, { available, checking: false, why });
  console.log(available ? '  Phone voice: ready ✓' : `  Phone voice: not available — ${why}`);
  broadcastAll(speech);
}

// ---------------------------------------------------------------- http
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  let rel;
  try {
    rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(data);
    } catch {
      // closing
    }
  }
}

const manager = new RoomManager({
  createSource: (username) => (DEMO ? new DemoSource(username) : new TikTokSource(username)),
  classifyError,
  settings: loadSavedSettings(),
  onSettings: saveSettingsSoon,
  broadcastAll,
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg?.type) {
      case 'join': {
        const username = normalizeUsername(msg.username);
        if (!username) {
          ws.send(JSON.stringify({ type: 'status', state: 'invalid', message: "That doesn't look like a TikTok username." }));
          return;
        }
        if (msg.settings) manager.updateSettings({ ...msg.settings, username });
        manager.join(ws, username, msg.mode === 'server' ? 'server' : 'browser');
        return;
      }
      case 'settings':
        manager.updateSettings(msg.settings);
        return;
      case 'control':
        manager.control(String(msg.action || ''), msg.text);
        return;
      case 'stop':
        manager.stopClientRoom(ws);
        return;
      case 'leave':
        manager.leave(ws);
        return;
      default:
    }
  });
  ws.on('close', () => manager.leave(ws));
  ws.on('error', () => {});
  ws.send(JSON.stringify({ type: 'hello', demo: DEMO, active: manager.activeRooms() }));
  ws.send(JSON.stringify(speech));
  if (manager.speaker) ws.send(JSON.stringify(manager.speaker.state()));
});

// Heartbeat: protocol pings drop dead sockets; the 'hb' message lets the page
// notice a dead connection even when its own timers are throttled.
const heartbeat = setInterval(() => {
  const hb = JSON.stringify({ type: 'hb', t: Date.now() });
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
      ws.send(hb);
    } catch {
      // closing
    }
  }
}, 15_000);

// ---------------------------------------------------------------- start
server.listen(PORT, HOST, async () => {
  const local = `http://localhost:${PORT}`;
  console.log(`\nTikTok LIVE TTS is running${DEMO ? ' in DEMO mode (fake chat)' : ''}.`);
  console.log(`  Open in your browser:  ${local}`);
  for (const ip of lanAddresses()) console.log(`  Open on your phone (same Wi-Fi):  http://${ip}:${PORT}`);
  console.log(
    IS_TERMUX
      ? '  Leave Termux running in the background while you stream. To stop: Ctrl+C (or close Termux).'
      : '  Keep this window open while you stream. Press Ctrl+C to stop.',
  );
  if (OPEN && !CLI_USER) openBrowser(local);
  await checkPhoneVoice();
  if (CLI_USER) {
    const username = normalizeUsername(CLI_USER);
    if (!username) {
      console.log(`\n  "${CLI_USER}" doesn't look like a TikTok username.\n`);
    } else if (!manager.speaker) {
      console.log(`\n  Can't read @${username} without a browser: the phone voice isn't available (see above).\n`);
      if (OPEN) openBrowser(local);
    } else {
      manager.updateSettings({ username });
      manager.startPinned(username);
      console.log(`\n  Reading @${username}'s LIVE with the phone voice. You can switch to TikTok now.`);
      console.log(`  Settings and chat: ${local}\n`);
    }
  }
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Is TikTok TTS already running? Close it, or run with PORT=3001.\n`);
    process.exit(1);
  }
  throw err;
});

function lanAddresses() {
  if (HOST !== '0.0.0.0' || IS_TERMUX) return [];
  try {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
  } catch {
    return []; // Android 11+ doesn't allow listing network interfaces
  }
}

function openBrowser(url) {
  const [cmd, cmdArgs] = IS_TERMUX
    ? ['termux-open-url', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser available; the URL is printed above
  }
}

async function shutdown() {
  clearInterval(heartbeat);
  await manager.closeAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => console.warn('Unhandled:', err?.message || err));
