// TikTok LIVE TTS server.
//   npm start        -> serves the page on http://localhost:3000 and opens it
//   npm run demo     -> same, but with a fake LIVE so you can test without streaming
//
// The browser page only sends your @username; this server does the TikTok part
// (browsers can't talk to TikTok's live chat directly) and streams the chat back.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { RoomManager } from './lib/rooms.js';
import { normalizeUsername } from './lib/username.js';
import { TikTokSource, classifyError } from './lib/tiktok-source.js';
import { DemoSource } from './lib/demo-source.js';

const args = process.argv.slice(2);
const DEMO = args.includes('--demo') || process.env.TTS_DEMO === '1';
const OPEN = args.includes('--open') && !process.env.NO_OPEN;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

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
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
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

const manager = new RoomManager({
  createSource: (username) => (DEMO ? new DemoSource(username) : new TikTokSource(username)),
  classifyError,
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

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
    if (msg?.type === 'join') {
      const username = normalizeUsername(msg.username);
      if (!username) {
        ws.send(JSON.stringify({ type: 'status', state: 'invalid', message: 'That doesn\'t look like a TikTok username.' }));
        return;
      }
      manager.join(ws, username);
    } else if (msg?.type === 'leave') {
      manager.leave(ws);
    }
  });
  ws.on('close', () => manager.leave(ws));
  ws.on('error', () => {});
  ws.send(JSON.stringify({ type: 'hello', demo: DEMO }));
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

server.listen(PORT, HOST, () => {
  const local = `http://localhost:${PORT}`;
  console.log(`\nTikTok LIVE TTS is running${DEMO ? ' in DEMO mode (fake chat)' : ''}.`);
  console.log(`  Open on this computer:  ${local}`);
  for (const ip of lanAddresses()) console.log(`  Open on your phone (same Wi-Fi):  http://${ip}:${PORT}`);
  console.log('  Keep this window open while you stream. Press Ctrl+C to stop.\n');
  if (OPEN) openBrowser(local);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Is TikTok TTS already running? Close it, or run with PORT=3001.\n`);
    process.exit(1);
  }
  throw err;
});

function lanAddresses() {
  if (HOST !== '0.0.0.0') return [];
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === 'win32'
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
