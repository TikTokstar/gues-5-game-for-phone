/* TikTok LIVE TTS — browser side.
 *
 * Gets chat from the local server over a WebSocket and reads it with the
 * browser's built-in speech (speechSynthesis).
 *
 * Staying alive when minimized:
 *  - All event flow is event-driven (WebSocket messages, utterance end events),
 *    which browsers keep delivering to hidden tabs.
 *  - Timers (watchdogs, reconnects) run in a Web Worker, which isn't throttled
 *    like timers on a hidden page.
 *  - A looping, inaudible 25 Hz tone makes the tab count as "playing audio", so
 *    Chrome/Edge never throttle, freeze or discard it (Memory Saver skips it too),
 *    and Android keeps the page running with a media notification.
 *  - A Web Lock is held while running (another signal browsers use to avoid
 *    freezing a page).
 *  - Everything self-heals: socket watchdog + reconnect, stuck-speech watchdog.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- settings
  const DEFAULTS = {
    username: '',
    voiceURI: '',
    rate: 1,
    pitch: 1,
    volume: 1,
    readChat: true,
    readGifts: true,
    readFollows: true,
    readShares: false,
    readJoins: false,
    readLikes: false,
    who: 'all',
    sayNames: true,
    nameSource: 'nickname',
    chatTemplate: '{name} says {text}',
    giftTemplate: '{name} sent {count} {gift}',
    followTemplate: '{name} followed',
    shareTemplate: '{name} shared the live',
    joinTemplate: 'Welcome {name}',
    likeTemplate: '{name} sent likes',
    minGiftCoins: 0,
    maxLength: 150,
    maxQueue: 10,
    userCooldown: 0,
    prefix: '',
    skipLinks: true,
    stripEmojis: true,
    collapseRepeats: true,
    skipCommands: true,
    skipDuplicates: true,
    blockedWords: '',
    ignoredUsers: '',
    keepAlive: true,
    keepScreenOn: false,
  };
  const STORE_KEY = 'tiktok-tts-settings-v1';

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {});
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(S));
    } catch (e) {
      /* private mode etc. — settings just won't be remembered */
    }
  }
  const S = loadSettings();

  // ---------------------------------------------------------------- dom
  const $ = (id) => document.getElementById(id);
  const ui = {
    form: $('startForm'),
    username: $('username'),
    startBtn: $('startBtn'),
    startHint: $('startHint'),
    status: $('status'),
    statusText: $('statusText'),
    statusMsg: $('statusMsg'),
    viewers: $('viewers'),
    viewerCount: $('viewerCount'),
    pauseBtn: $('pauseBtn'),
    skipBtn: $('skipBtn'),
    clearBtn: $('clearBtn'),
    queueLen: $('queueLen'),
    bgStatus: $('bgStatus'),
    feed: $('feed'),
    feedEmpty: $('feedEmpty'),
    voice: $('voice'),
    voiceNote: $('voiceNote'),
    testText: $('testText'),
    testBtn: $('testBtn'),
  };

  const now = () => Date.now();
  const hasSpeech = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const synth = hasSpeech ? window.speechSynthesis : null;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isGoogleChrome = /Chrome\//.test(navigator.userAgent) && !/Edg\/|OPR\//.test(navigator.userAgent) && !isAndroid;

  let running = false;

  // ---------------------------------------------------------------- ticker (Web Worker)
  // Timers inside a worker keep firing on schedule when the page is hidden.
  const tickHandlers = [];
  function onTick(fn) {
    tickHandlers.push(fn);
  }
  function runTick() {
    for (const fn of tickHandlers) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }
  (function startTicker() {
    try {
      const src = 'setInterval(function(){postMessage(0)},250);';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = runTick;
      w.onerror = () => setInterval(runTick, 250);
    } catch (e) {
      setInterval(runTick, 250);
    }
  })();

  // ---------------------------------------------------------------- text cleanup
  const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}︎️‍⃣]/gu;
  const LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|gg|tv|me|co|ly|xyz|app|link|ru|info|biz|shop|store|live)\b\S*/gi;

  function cleanText(input) {
    let t = String(input || '').normalize('NFKC');
    if (S.skipLinks) t = t.replace(LINK_RE, ' ');
    if (S.stripEmojis) t = t.replace(/\[[a-z0-9_]{1,24}\]/gi, ' ').replace(EMOJI_RE, '');
    if (S.collapseRepeats) {
      t = t.replace(/(.)\1{2,}/gsu, '$1$1'); // "loooool" -> "lool", "!!!!!" -> "!!"
      t = t.replace(/(^|\s)(\S+)(?:\s+\2(?=\s|$)){2,}/giu, '$1$2 $2'); // "lol lol lol lol" -> "lol lol"
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  function truncate(t, max) {
    max = Math.max(20, Number(max) || 150);
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
  }

  function spokenName(user) {
    const uniqueId = (user && user.uniqueId) || '';
    let n = S.nameSource === 'username' ? uniqueId : (user && user.nickname) || uniqueId;
    n = String(n).normalize('NFKC').replace(EMOJI_RE, '').replace(/[^\p{L}\p{N}\s._'-]/gu, ' ');
    if (!/[\p{L}\p{N}]/u.test(n)) n = uniqueId;
    // "gamer_kid.99" -> "gamer kid 99"; drop long trailing number tails like "mila20481234"
    n = n.replace(/[._]+/g, ' ').replace(/(\p{L})\d{4,}$/u, '$1');
    if (S.collapseRepeats) n = n.replace(/(.)\1{2,}/gsu, '$1$1');
    n = n.replace(/\s+/g, ' ').trim();
    return truncate(n || 'someone', 30);
  }

  function fill(template, vars) {
    return String(template || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }

  function listSetting(str) {
    return String(str || '')
      .split(/[,\n]/)
      .map((w) => w.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);
  }
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function containsBlocked(text) {
    const words = listSetting(S.blockedWords);
    if (!words.length) return false;
    return words.some((w) => new RegExp('(^|[^\\p{L}\\p{N}])' + escapeRe(w) + '($|[^\\p{L}\\p{N}])', 'iu').test(text));
  }

  function plural(gift, count) {
    if (count <= 1 || /s$/i.test(gift)) return gift;
    return gift + 's';
  }

  // ---------------------------------------------------------------- speech
  const tts = {
    queue: [],
    current: null, // { u, item, startedAt, expectMs, nudgedAt }
    paused: false,
  };
  let voices = [];

  function pickVoice() {
    if (!voices.length) return null;
    return voices.find((v) => v.voiceURI === S.voiceURI) || null;
  }

  function enqueue(text, feedItem, kind) {
    if (!hasSpeech) {
      setTag(feedItem, 'skipped', 'no speech');
      return;
    }
    if (tts.paused) {
      setTag(feedItem, 'skipped', 'paused');
      return;
    }
    const max = Math.max(1, Number(S.maxQueue) || 10);
    while (tts.queue.length >= max) {
      // Drop the oldest chat message first so gifts/follows still get read.
      let i = tts.queue.findIndex((q) => q.kind === 'chat');
      if (i === -1) i = 0;
      const [dropped] = tts.queue.splice(i, 1);
      setTag(dropped.feedItem, 'skipped', 'too busy');
    }
    tts.queue.push({ text, feedItem, kind });
    setTag(feedItem, 'queued');
    updateQueue();
    pump();
  }

  function pump() {
    if (!hasSpeech || tts.current || tts.paused || !tts.queue.length) return;
    const item = tts.queue.shift();
    updateQueue();
    const u = new SpeechSynthesisUtterance(item.text);
    const v = pickVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = Number(S.rate) || 1;
    u.pitch = Number(S.pitch);
    u.volume = Number(S.volume);
    const charsPerSec = 13 * u.rate;
    tts.current = {
      u: u, // keep a reference: Chrome can garbage-collect utterances and never fire 'end'
      item: item,
      startedAt: now(),
      expectMs: Math.min(60000, 2500 + (item.text.length / charsPerSec) * 1000),
      nudgedAt: now(),
    };
    u.onend = () => finish(u, 'read');
    u.onerror = (e) => finish(u, e && (e.error === 'interrupted' || e.error === 'canceled') ? 'skipped' : 'read');
    setTag(item.feedItem, 'speaking');
    try {
      if (synth.paused) synth.resume();
      synth.speak(u);
    } catch (e) {
      finish(u, 'skipped');
    }
  }

  function finish(u, tag) {
    const cur = tts.current;
    if (!cur || cur.u !== u) return;
    tts.current = null;
    setTag(cur.item.feedItem, tag);
    Promise.resolve().then(pump);
  }

  // Stops the current message. The next one starts on the next tick, because
  // Chrome sometimes ignores speak() called right after cancel().
  function abortCurrent(tag) {
    const cur = tts.current;
    if (!cur) return;
    tts.current = null;
    setTag(cur.item.feedItem, tag);
    try {
      synth.cancel();
    } catch (e) {
      /* ignore */
    }
  }
  function skipCurrent() {
    abortCurrent('skipped');
  }

  function voiceIsRemote() {
    const v = pickVoice() || voices.find((x) => x.default);
    return Boolean(v && v.localService === false);
  }

  function clearQueue() {
    for (const q of tts.queue) setTag(q.feedItem, 'skipped', 'cleared');
    tts.queue = [];
    updateQueue();
  }

  // Speech watchdog: recovers from the well-known Chrome speechSynthesis hangs.
  onTick(() => {
    if (!hasSpeech) return;
    const cur = tts.current;
    if (cur) {
      const t = now();
      const elapsed = t - cur.startedAt;
      if (elapsed > cur.expectMs + 8000) {
        // Stuck: never started or never ended.
        abortCurrent('skipped');
      } else if (elapsed > 3000 && !synth.speaking && !synth.pending) {
        // Ended, but the browser forgot to fire 'end'.
        finish(cur.u, 'read');
      } else if (isGoogleChrome && t - cur.nudgedAt > 10000 && synth.speaking && voiceIsRemote()) {
        // Desktop Chrome's online Google voices stop after ~15s unless poked.
        cur.nudgedAt = t;
        synth.pause();
        synth.resume();
      }
    }
    pump();
  });

  function loadVoices() {
    if (!hasSpeech) return;
    voices = synth.getVoices().slice();
    const lang = (navigator.language || 'en').toLowerCase().split('-')[0];
    voices.sort((a, b) => {
      const al = a.lang.toLowerCase().startsWith(lang) ? 0 : 1;
      const bl = b.lang.toLowerCase().startsWith(lang) ? 0 : 1;
      const an = /natural|neural|online/i.test(a.name) ? 0 : 1;
      const bn = /natural|neural|online/i.test(b.name) ? 0 : 1;
      return al - bl || an - bn || a.name.localeCompare(b.name);
    });
    ui.voice.textContent = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Browser default voice';
    ui.voice.appendChild(def);
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = v.name + ' (' + v.lang + ')' + (v.localService === false ? ' · online' : '');
      ui.voice.appendChild(o);
    }
    ui.voice.value = voices.some((v) => v.voiceURI === S.voiceURI) ? S.voiceURI : '';
    const hasNatural = voices.some((v) => /natural/i.test(v.name));
    ui.voiceNote.textContent = !voices.length
      ? 'Loading voices…'
      : hasNatural
        ? 'Tip: voices marked "Natural" sound the most human.'
        : 'Tip: open this page in Microsoft Edge for much more natural-sounding voices.';
  }
  if (hasSpeech) {
    loadVoices();
    if ('onvoiceschanged' in synth) synth.addEventListener('voiceschanged', loadVoices);
    // Some browsers fill the list late without firing the event.
    let tries = 0;
    const vt = setInterval(() => {
      if (voices.length || ++tries > 20) return clearInterval(vt);
      loadVoices();
    }, 250);
  }

  // ---------------------------------------------------------------- keep alive in background
  const keep = { audio: null, url: null, lockRelease: null, wake: null };

  function keepAliveWavUrl() {
    // A 25 Hz sine at -54 dBFS: below what people (and speakers) can hear, but
    // above the level browsers use to decide a tab is "playing audio".
    // Desktop: a 2 s loop, too short for the browser to grab your keyboard's
    // play/pause keys. Android: 10 s, so it gets a media notification, which is
    // what keeps the page running in the background there.
    const rate = 8000;
    const n = rate * (isAndroid ? 10 : 2);
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const str = (o, s) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
    };
    str(0, 'RIFF');
    dv.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    str(36, 'data');
    dv.setUint32(40, n * 2, true);
    const amp = 32767 * 0.002;
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 25 * i) / rate) * amp), true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  function startKeepAlive() {
    // Must be called from a click so audio is allowed to start.
    if (S.keepAlive) {
      if (!keep.audio) {
        keep.url = keep.url || keepAliveWavUrl();
        const a = new Audio(keep.url);
        a.loop = true;
        a.preload = 'auto';
        a.setAttribute('playsinline', '');
        keep.audio = a;
      }
      keep.audio.play().catch(() => {});
      setupMediaSession();
    }
    if (navigator.locks && !keep.lockRelease) {
      navigator.locks
        .request('tiktok-tts-alive-' + Math.random().toString(36).slice(2), () => new Promise((res) => (keep.lockRelease = res)))
        .catch(() => {});
    }
    requestWakeLock();
    updateBgStatus();
  }

  function stopKeepAlive() {
    if (keep.audio) {
      keep.audio.pause();
      keep.audio = null;
    }
    if (keep.lockRelease) {
      keep.lockRelease();
      keep.lockRelease = null;
    }
    if (keep.wake) {
      keep.wake.release().catch(() => {});
      keep.wake = null;
    }
    if (isAndroid && 'mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    updateBgStatus();
  }

  function requestWakeLock() {
    if (!running || !S.keepScreenOn || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    if (keep.wake && !keep.wake.released) return;
    navigator.wakeLock
      .request('screen')
      .then((w) => (keep.wake = w))
      .catch(() => {});
  }

  function setupMediaSession() {
    // Only on Android, where the media notification keeps the page alive and
    // doubles as a pause button. On computers it would steal the play/pause keys.
    if (!isAndroid || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'TikTok LIVE TTS is running',
        artist: S.username ? '@' + S.username : '',
      });
      navigator.mediaSession.playbackState = tts.paused ? 'paused' : 'playing';
      navigator.mediaSession.setActionHandler('pause', () => setPaused(true));
      navigator.mediaSession.setActionHandler('play', () => setPaused(false));
      navigator.mediaSession.setActionHandler('stop', () => setPaused(true));
    } catch (e) {
      /* not supported */
    }
  }

  // If the OS/browser paused our keep-alive audio (e.g. another app took audio), restart it.
  let lastAudioCheck = 0;
  onTick(() => {
    if (!running || !S.keepAlive || !keep.audio) return;
    if (now() - lastAudioCheck < 2000) return;
    lastAudioCheck = now();
    if (keep.audio.paused) keep.audio.play().catch(() => {});
    updateBgStatus();
  });

  function updateBgStatus() {
    const el = ui.bgStatus;
    if (!running) {
      el.textContent = '';
      return;
    }
    if (isIOS) {
      el.className = 'bg-status warn';
      el.textContent = '⚠ iPhone/iPad stop web pages in the background. Keep this page open on screen (turn on "Keep screen on"), or run it on a computer.';
    } else if (!S.keepAlive) {
      el.className = 'bg-status warn';
      el.textContent = '⚠ Background mode is off. The browser may slow this tab down when minimized.';
    } else if (keep.audio && !keep.audio.paused && isAndroid) {
      el.className = 'bg-status ok';
      el.textContent =
        '✓ Background mode on — you can switch to the TikTok app. Don\'t swipe Chrome or Termux away. ' +
        'Xiaomi/Poco/Redmi: set Battery saver to "No restrictions" for Chrome and Termux.';
    } else if (keep.audio && !keep.audio.paused) {
      el.className = 'bg-status ok';
      el.textContent = '✓ Background mode on — safe to minimize the window or switch tabs. Just don\'t close this tab.';
    } else {
      el.className = 'bg-status warn';
      el.textContent = '⚠ Background mode is waiting for the browser to allow audio. Click anywhere on this page once.';
    }
  }

  // ---------------------------------------------------------------- server connection
  const net = {
    ws: null,
    want: false,
    attempts: 0,
    retryAt: 0,
    lastMsgAt: 0,
  };

  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  function openSocket() {
    if (net.ws || !net.want) return;
    if (location.protocol === 'file:') {
      setStatus('error', 'Server not running', 'Open this page through the server: run "npm start" in the tiktok-tts folder, then go to http://localhost:3000');
      net.want = false;
      return;
    }
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }
    net.ws = ws;
    net.lastMsgAt = now();
    ws.onopen = () => {
      net.attempts = 0;
      ws.send(JSON.stringify({ type: 'join', username: S.username }));
    };
    ws.onmessage = (e) => {
      net.lastMsgAt = now();
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      handleServerMessage(msg);
    };
    ws.onclose = () => {
      if (net.ws !== ws) return;
      net.ws = null;
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  function dropSocket() {
    const ws = net.ws;
    net.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch (e) {
      /* ignore */
    }
  }

  function scheduleReconnect() {
    if (!net.want) return;
    const delay = Math.min(1000 * 2 ** net.attempts, 15000);
    net.attempts += 1;
    net.retryAt = now() + delay;
    setStatus('server', 'Reconnecting…', 'Lost connection to the TTS server. Reconnecting in ' + Math.round(delay / 1000) + 's… (is the server window still open?)');
  }

  onTick(() => {
    if (!net.want) return;
    if (!net.ws) {
      if (now() >= net.retryAt) openSocket();
      return;
    }
    // Server sends a heartbeat every 15s; silence for 40s means the socket is dead.
    if (now() - net.lastMsgAt > 40000) {
      dropSocket();
      net.retryAt = 0;
    }
  });

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'hello':
        if (msg.demo) ui.startHint.textContent = 'DEMO MODE: the server is sending fake chat so you can test voices and settings.';
        return;
      case 'hb':
        return;
      case 'status':
        onStatus(msg);
        return;
      case 'viewers':
        showViewers(msg.count);
        return;
      default:
        onLiveEvent(msg);
    }
  }

  let lastState = '';
  function onStatus(msg) {
    const labels = {
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      live: 'LIVE',
      offline: 'Waiting for LIVE',
      error: 'Retrying…',
      invalid: 'Check username',
    };
    setStatus(msg.state, labels[msg.state] || msg.state, msg.message || '');
    if (typeof msg.viewers === 'number') showViewers(msg.viewers);
    if (msg.state === 'invalid') {
      stop();
      setStatus('invalid', labels.invalid, msg.message);
      return;
    }
    if (msg.state !== lastState) {
      if (msg.state === 'live') addSystem('Connected to @' + msg.username + "'s LIVE.");
      else if (msg.state === 'offline' && lastState === 'live') addSystem('The LIVE ended. Waiting for the next one…');
      lastState = msg.state;
    }
  }

  // ---------------------------------------------------------------- events -> speech
  const recent = new Map(); // duplicate detection: key -> time
  const lastByUser = new Map(); // cooldown: uniqueId -> time
  const lastLikeByUser = new Map();

  function onLiveEvent(ev) {
    if (!running) return;
    const user = ev.user || {};
    const uid = String(user.uniqueId || '').toLowerCase();
    const display = user.nickname || user.uniqueId || 'someone';
    const ignored = uid && listSetting(S.ignoredUsers).includes(uid);
    const name = spokenName(user);

    if (ev.type === 'chat') {
      const item = addFeed('chat', display, ev.text);
      if (!S.readChat) return setTag(item, 'skipped', 'chat off');
      if (ignored) return setTag(item, 'skipped', 'ignored');
      const allowed =
        S.who === 'all' ||
        ev.isHost ||
        ev.isMod ||
        (S.who === 'subs' && ev.isSub) ||
        (S.who === 'followers' && (ev.isSub || ev.isFollower));
      if (!allowed) return setTag(item, 'skipped', 'not allowed');
      let text = String(ev.text || '').trim();
      const prefix = String(S.prefix || '').trim();
      if (prefix) {
        if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return setTag(item, 'skipped', 'no ' + prefix);
        text = text.slice(prefix.length).trim();
      } else if (S.skipCommands && /^[!/]/.test(text)) {
        return setTag(item, 'skipped', 'command');
      }
      if (containsBlocked(text)) return setTag(item, 'skipped', 'blocked word');
      text = cleanText(text);
      if (!/[\p{L}\p{N}]/u.test(text)) return setTag(item, 'skipped', 'nothing to read');
      const t = now();
      if (S.skipDuplicates) {
        for (const [k, at] of recent) if (t - at > 60000) recent.delete(k);
        const key = uid + '|' + text.toLowerCase();
        if (recent.has(key)) return setTag(item, 'skipped', 'repeat');
        recent.set(key, t);
      }
      const cd = Number(S.userCooldown) || 0;
      if (cd > 0 && uid) {
        if (t - (lastByUser.get(uid) || 0) < cd * 1000) return setTag(item, 'skipped', 'cooldown');
        lastByUser.set(uid, t);
      }
      text = truncate(text, S.maxLength);
      const spoken = S.sayNames ? fill(S.chatTemplate || '{name} says {text}', { name, text }) : text;
      return enqueue(spoken, item, 'chat');
    }

    if (ev.type === 'gift') {
      const count = Number(ev.count) || 1;
      const giftName = cleanText(ev.gift) || 'a gift';
      const item = addFeed('gift', display, 'sent ' + (count > 1 ? count + '× ' : '') + ev.gift);
      if (!S.readGifts) return setTag(item, 'skipped', 'gifts off');
      if (ignored) return setTag(item, 'skipped', 'ignored');
      if ((Number(ev.coins) || 0) < (Number(S.minGiftCoins) || 0)) return setTag(item, 'skipped', 'small gift');
      return enqueue(fill(S.giftTemplate, { name, gift: plural(giftName, count), count }), item, 'gift');
    }

    if (ev.type === 'follow' || ev.type === 'share') {
      const item = addFeed(ev.type, display, ev.type === 'follow' ? 'followed' : 'shared the LIVE');
      const on = ev.type === 'follow' ? S.readFollows : S.readShares;
      if (!on) return setTag(item, 'skipped', 'off');
      if (ignored) return setTag(item, 'skipped', 'ignored');
      return enqueue(fill(ev.type === 'follow' ? S.followTemplate : S.shareTemplate, { name }), item, ev.type);
    }

    if (ev.type === 'join') {
      if (!S.readJoins || ignored) return; // joins are too frequent to show when not read
      const item = addFeed('join', display, 'joined');
      return enqueue(fill(S.joinTemplate, { name }), item, 'join');
    }

    if (ev.type === 'like') {
      if (!S.readLikes || ignored) return;
      const t = now();
      if (t - (lastLikeByUser.get(uid) || 0) < 60000) return; // at most once a minute per person
      lastLikeByUser.set(uid, t);
      const item = addFeed('like', display, 'sent likes');
      return enqueue(fill(S.likeTemplate, { name, count: ev.count || 1 }), item, 'like');
    }
  }

  // ---------------------------------------------------------------- feed ui
  const FEED_MAX = 150;
  function addFeed(kind, who, what) {
    const li = document.createElement('li');
    li.className = 'ev-' + kind;
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    const tag = document.createElement('span');
    tag.className = 'tag';
    const t = document.createElement('span');
    t.className = 'what';
    t.textContent = what;
    li.append(w, tag, t);
    li._tag = tag;
    ui.feed.prepend(li);
    while (ui.feed.children.length > FEED_MAX) ui.feed.lastElementChild.remove();
    ui.feedEmpty.style.display = 'none';
    return li;
  }
  function addSystem(text) {
    const li = document.createElement('li');
    li.className = 'sys';
    const t = document.createElement('span');
    t.className = 'what';
    t.textContent = text;
    li.append(t);
    ui.feed.prepend(li);
    ui.feedEmpty.style.display = 'none';
  }
  function setTag(li, state, reason) {
    if (!li || !li._tag) return;
    li._tag.className = 'tag ' + state;
    li._tag.textContent = reason ? state + ' · ' + reason : state;
  }
  function updateQueue() {
    ui.queueLen.textContent = String(tts.queue.length);
  }
  function showViewers(n) {
    if (typeof n !== 'number') return;
    ui.viewerCount.textContent = n.toLocaleString();
    ui.viewers.classList.add('show');
  }

  let pillState = 'idle';
  function setStatus(state, label, message) {
    pillState = state;
    ui.status.dataset.state = state;
    ui.statusText.textContent = label;
    ui.statusMsg.textContent = message || '';
    ui.statusMsg.classList.toggle('err', state === 'invalid' || (state === 'error' && !running));
    updateTitle();
  }
  function updateTitle() {
    let t = 'TikTok TTS';
    if (running) t = (pillState === 'live' ? '🔴 ' : '⏳ ') + t + (tts.paused ? ' (paused)' : '');
    document.title = t;
  }

  // ---------------------------------------------------------------- start / stop
  function normalizeUsername(input) {
    let s = String(input || '').trim();
    const m = s.match(/tiktok\.com\/@([^/?#\s]+)/i);
    if (m) s = m[1];
    s = s.replace(/^@+/, '').trim().toLowerCase();
    return /^[a-z0-9._]{1,24}$/.test(s) ? s : null;
  }

  function unlockSpeech() {
    // Browsers only allow speech after a click; speaking once from the click unlocks it for good.
    if (!hasSpeech) return;
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch (e) {
      /* ignore */
    }
  }

  function start() {
    const name = normalizeUsername(ui.username.value);
    if (!name) {
      setStatus('invalid', 'Check username', 'Type your TikTok username, like @yourname.');
      ui.username.focus();
      return;
    }
    if (!hasSpeech) {
      setStatus('error', 'No speech', "This browser can't speak text. Use Chrome or Edge.");
      return;
    }
    S.username = name;
    ui.username.value = name;
    saveSettings();
    running = true;
    lastState = '';
    tts.paused = false;
    document.body.classList.add('running');
    ui.startBtn.textContent = 'Stop';
    ui.startBtn.classList.add('stop');
    ui.username.disabled = true;
    unlockSpeech();
    startKeepAlive();
    updatePauseBtn();
    net.want = true;
    net.attempts = 0;
    net.retryAt = 0;
    setStatus('connecting', 'Connecting…', 'Connecting to @' + name + '…');
    openSocket();
    try {
      sessionStorage.setItem('tiktok-tts-running', '1');
    } catch (e) {
      /* ignore */
    }
  }

  function stop() {
    running = false;
    net.want = false;
    if (net.ws && net.ws.readyState === 1) {
      try {
        net.ws.send(JSON.stringify({ type: 'leave' }));
      } catch (e) {
        /* ignore */
      }
    }
    dropSocket();
    clearQueue();
    skipCurrent();
    stopKeepAlive();
    document.body.classList.remove('running');
    ui.startBtn.textContent = 'Start';
    ui.startBtn.classList.remove('stop');
    ui.username.disabled = false;
    ui.viewers.classList.remove('show');
    setStatus('idle', 'Not running', '');
    try {
      sessionStorage.removeItem('tiktok-tts-running');
    } catch (e) {
      /* ignore */
    }
  }

  function setPaused(p) {
    tts.paused = p;
    if (p) {
      clearQueue();
      skipCurrent();
    }
    if (isAndroid && 'mediaSession' in navigator && running) navigator.mediaSession.playbackState = p ? 'paused' : 'playing';
    updatePauseBtn();
    updateTitle();
    pump();
  }
  function updatePauseBtn() {
    ui.pauseBtn.textContent = tts.paused ? '▶ Resume reading' : '⏸ Pause reading';
  }

  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (running) stop();
    else start();
  });
  ui.pauseBtn.addEventListener('click', () => setPaused(!tts.paused));
  ui.skipBtn.addEventListener('click', skipCurrent);
  ui.clearBtn.addEventListener('click', clearQueue);
  ui.testBtn.addEventListener('click', () => {
    if (!hasSpeech) return;
    const text = cleanText(ui.testText.value) || 'Hello!';
    const item = addFeed('chat', 'Test', ui.testText.value);
    if (tts.paused) setPaused(false);
    enqueue(text, item, 'test');
  });

  // ---------------------------------------------------------------- settings form binding
  function bindSettings() {
    document.querySelectorAll('[data-setting]').forEach((el) => {
      const key = el.dataset.setting;
      const out = document.querySelector('output[data-for="' + key + '"]');
      const show = () => {
        if (out) out.textContent = key === 'volume' ? Math.round(S[key] * 100) + '%' : Number(S[key]).toFixed(2) + '×';
      };
      if (el.type === 'checkbox') el.checked = Boolean(S[key]);
      else if (key !== 'voiceURI') el.value = S[key];
      show();
      const update = () => {
        if (el.type === 'checkbox') S[key] = el.checked;
        else if (el.type === 'number' || el.type === 'range') S[key] = el.value === '' ? DEFAULTS[key] : Number(el.value);
        else S[key] = el.value;
        saveSettings();
        show();
        if (key === 'keepAlive' && running) {
          if (S.keepAlive) startKeepAlive();
          else if (keep.audio) {
            keep.audio.pause();
            keep.audio = null;
            updateBgStatus();
          }
        }
        if (key === 'keepScreenOn') {
          if (S.keepScreenOn) requestWakeLock();
          else if (keep.wake) {
            keep.wake.release().catch(() => {});
            keep.wake = null;
          }
        }
      };
      el.addEventListener('change', update);
      if (el.type === 'range' || el.type === 'text' || el.tagName === 'TEXTAREA') el.addEventListener('input', update);
    });
  }
  bindSettings();

  // ---------------------------------------------------------------- page lifecycle
  function wakeUp() {
    // Back from hidden/frozen: check everything right away.
    if (!running) return;
    if (net.ws && now() - net.lastMsgAt > 40000) {
      dropSocket();
      net.retryAt = 0;
    }
    if (S.keepAlive && keep.audio && keep.audio.paused) keep.audio.play().catch(() => {});
    requestWakeLock();
    runTick();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wakeUp();
  });
  document.addEventListener('resume', wakeUp);
  window.addEventListener('online', () => {
    if (net.want && !net.ws) net.retryAt = 0;
  });
  window.addEventListener('pageshow', wakeUp);
  // Any click re-arms audio if the browser blocked it earlier.
  document.addEventListener('pointerdown', () => {
    if (running && S.keepAlive && keep.audio && keep.audio.paused) keep.audio.play().then(updateBgStatus).catch(() => {});
  });
  window.addEventListener('beforeunload', (e) => {
    if (!running) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---------------------------------------------------------------- init
  const params = new URLSearchParams(location.search);
  ui.username.value = normalizeUsername(params.get('u') || params.get('user') || '') || S.username || '';
  let wasRunning = false;
  try {
    wasRunning = sessionStorage.getItem('tiktok-tts-running') === '1';
  } catch (e) {
    /* ignore */
  }
  if (!hasSpeech) {
    setStatus('error', 'No speech', "This browser can't speak text. Use Chrome or Edge on a computer or Android.");
  } else if (wasRunning && ui.username.value) {
    setStatus('idle', 'Paused', 'The page was reloaded. Press Start to continue (browsers need one click before they can talk).');
  }
  if (ui.username.value) ui.startBtn.focus();
  else ui.username.focus();

  // Small hook for automated tests.
  window.__tts = { S, tts, net, keep, cleanText, spokenName, onLiveEvent, get running() { return running; } };
})();
