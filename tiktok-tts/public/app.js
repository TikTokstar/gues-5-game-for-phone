/* TikTok LIVE TTS — browser side.
 *
 * Two ways to speak:
 *  - Phone voice (Android + Termux): the server decides what to say and speaks
 *    it with the phone's own voice. This page is only a remote control and chat
 *    view, so it can be minimized or closed and the reading goes on.
 *  - Browser voice (computers): this page speaks with speechSynthesis. To keep
 *    going when minimized it plays an inaudible tone (so the tab counts as
 *    "playing audio" and isn't throttled/frozen), runs its timers in a Web
 *    Worker, holds a Web Lock, and has watchdogs for the socket and speech.
 */
(function () {
  'use strict';

  const B = window.TTSBrain;
  const LANG = navigator.language || 'en';

  // ---------------------------------------------------------------- settings
  const STORE_KEY = 'tiktok-tts-settings-v1';
  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    } catch (e) {
      /* ignore */
    }
    const s = B.withDefaults(saved, LANG);
    s.lang = LANG;
    return s;
  }
  const S = loadSettings();
  let settingsTimer = null;
  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(S));
    } catch (e) {
      /* private mode etc. — settings just won't be remembered */
    }
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => sendMsg({ type: 'settings', settings: S }), 300);
  }

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
    speakNote: $('speakNote'),
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
  let mode = 'browser'; // how the current run speaks: 'server' (phone voice) or 'browser'
  let speech = { available: false, checking: true, why: '' }; // phone voice status from the server
  let serverPaused = false;

  function phoneWanted() {
    return S.speakOn !== 'browser' && speech.available;
  }

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

  // ---------------------------------------------------------------- browser speech
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

  function clearQueue() {
    for (const q of tts.queue) setTag(q.feedItem, 'skipped', 'cleared');
    tts.queue = [];
    updateQueue();
  }

  function voiceIsRemote() {
    const v = pickVoice() || voices.find((x) => x.default);
    return Boolean(v && v.localService === false);
  }

  // Speech watchdog: recovers from the well-known Chrome speechSynthesis hangs.
  onTick(() => {
    if (!hasSpeech) return;
    const cur = tts.current;
    if (cur) {
      const t = now();
      const elapsed = t - cur.startedAt;
      if (elapsed > cur.expectMs + 8000) {
        abortCurrent('skipped'); // stuck: never started or never ended
      } else if (elapsed > 3000 && !synth.speaking && !synth.pending) {
        finish(cur.u, 'read'); // ended, but the browser forgot to fire 'end'
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
    const lang = LANG.toLowerCase().split('-')[0];
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
        : 'Tip: on a computer, Microsoft Edge has much more natural-sounding voices.';
  }
  if (hasSpeech) {
    loadVoices();
    if ('onvoiceschanged' in synth) synth.addEventListener('voiceschanged', loadVoices);
    let tries = 0;
    const vt = setInterval(() => {
      if (voices.length || ++tries > 20) return clearInterval(vt);
      loadVoices();
    }, 250);
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

  // ---------------------------------------------------------------- keep alive (browser voice)
  const keep = { audio: null, url: null, lockRelease: null, wake: null };

  function keepAliveWavUrl() {
    // A 25 Hz sine at -54 dBFS: below what people (and speakers) can hear, but
    // above the level browsers use to decide a tab is "playing audio".
    // Desktop: a 2 s loop, too short for the browser to grab the play/pause keys.
    // Android: 10 s, so it gets a media notification.
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
    // Only on Android, where the media notification helps keep the page alive.
    // On computers it would steal the keyboard's play/pause keys.
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

  // If the OS/browser paused our keep-alive audio, restart it.
  let lastAudioCheck = 0;
  onTick(() => {
    if (!running || mode !== 'browser' || !S.keepAlive || !keep.audio) return;
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
    if (mode === 'server') {
      el.className = 'bg-status ok';
      el.textContent =
        '✓ Termux reads the chat with the phone voice — you can minimize or even close Chrome and go LIVE. ' +
        "Just don't swipe Termux away.";
    } else if (isIOS) {
      el.className = 'bg-status warn';
      el.textContent = '⚠ iPhone/iPad stop web pages in the background. Keep this page open on screen (turn on "Keep screen on"), or run it on a computer.';
    } else if (isAndroid) {
      el.className = 'bg-status warn';
      el.textContent =
        '⚠ Chrome on Android stops talking when minimized. Use the phone voice instead: in Termux run "tts update", then reopen this page.';
    } else if (!S.keepAlive) {
      el.className = 'bg-status warn';
      el.textContent = '⚠ Background mode is off. The browser may slow this tab down when minimized.';
    } else if (keep.audio && !keep.audio.paused) {
      el.className = 'bg-status ok';
      el.textContent = "✓ Background mode on — safe to minimize the window or switch tabs. Just don't close this tab.";
    } else {
      el.className = 'bg-status warn';
      el.textContent = '⚠ Background mode is waiting for the browser to allow audio. Click anywhere on this page once.';
    }
  }

  function updateSpeakNote() {
    const el = ui.speakNote;
    if (speech.available) {
      el.className = 'note ok';
      el.textContent =
        S.speakOn === 'browser'
          ? 'Phone voice is ready, but you chose the browser. The browser stops talking when Chrome is minimized.'
          : '✓ Phone voice ready — keeps reading when Chrome is minimized or closed.';
    } else if (speech.checking) {
      el.className = 'note';
      el.textContent = 'Checking the phone voice…';
    } else if (isAndroid || S.speakOn === 'phone') {
      el.className = 'note warn';
      el.textContent = '⚠ Phone voice not available: ' + (speech.why || 'unknown reason');
    } else {
      el.className = 'note';
      el.textContent = '';
    }
    document.body.classList.toggle('phone', running ? mode === 'server' : phoneWanted());
  }

  // ---------------------------------------------------------------- server connection
  const net = {
    ws: null,
    want: location.protocol !== 'file:',
    attempts: 0,
    retryAt: 0,
    lastMsgAt: 0,
  };

  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  function socketOpen() {
    return Boolean(net.ws && net.ws.readyState === 1);
  }

  function sendMsg(msg) {
    if (!socketOpen()) return false;
    try {
      net.ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      return false;
    }
  }

  function sendJoin() {
    sendMsg({ type: 'join', username: S.username, mode: mode, settings: S });
  }

  function openSocket() {
    if (net.ws || !net.want) return;
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
      if (running) sendJoin();
      else sendMsg({ type: 'settings', settings: S });
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
    if (running) {
      setStatus(
        'server',
        'Reconnecting…',
        'Lost connection to the TTS server. Reconnecting in ' + Math.round(delay / 1000) + 's… (is Termux / the server window still open?)',
      );
    }
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
        // The phone is already reading a LIVE (e.g. Chrome was closed and reopened): show it.
        if (!running && Array.isArray(msg.active) && msg.active.length) attach(msg.active[0].username);
        return;
      case 'speaker': {
        const before = speech.available;
        speech = msg;
        updateSpeakNote();
        // The phone voice became ready after Start was pressed: switch to it.
        if (running && mode === 'browser' && !before && phoneWanted()) restart();
        return;
      }
      case 'queue':
        serverPaused = Boolean(msg.paused);
        if (mode === 'server') {
          ui.queueLen.textContent = String(msg.length || 0);
          updatePauseBtn();
          updateTitle();
        }
        return;
      case 'tag':
        setTag(feedById.get(msg.fid), msg.state, msg.reason);
        return;
      case 'test':
        addServerFeed(msg);
        return;
      case 'hb':
        return;
      case 'status':
        if (running) onStatus(msg);
        return;
      case 'viewers':
        if (running) showViewers(msg.count);
        return;
      default:
        if (!running) return;
        if (msg.feed) addServerFeed(msg); // phone mode: the server already decided and speaks it
        else if (mode === 'browser') onLiveEvent(msg);
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
    if (msg.state === 'invalid') {
      stop();
      setStatus('invalid', labels.invalid, msg.message);
      return;
    }
    setStatus(msg.state, labels[msg.state] || msg.state, msg.message || '');
    if (typeof msg.viewers === 'number') showViewers(msg.viewers);
    if (msg.state !== lastState) {
      if (msg.state === 'live') addSystem('Connected to @' + msg.username + "'s LIVE.");
      else if (msg.state === 'offline' && lastState === 'live') addSystem('The LIVE ended. Waiting for the next one…');
      lastState = msg.state;
    }
  }

  // ---------------------------------------------------------------- events -> speech (browser voice)
  const mem = B.createMemory();

  function onLiveEvent(ev) {
    const d = B.decide(ev, S, mem);
    if (!d) return;
    const item = addFeed(d.kind, d.who, d.what);
    if (!d.speak) return setTag(item, 'skipped', d.reason);
    enqueue(d.speak, item, d.kind);
  }

  // ---------------------------------------------------------------- feed ui
  const FEED_MAX = 150;
  const feedById = new Map();

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
    while (ui.feed.children.length > FEED_MAX) {
      const old = ui.feed.lastElementChild;
      if (old._fid) feedById.delete(old._fid);
      old.remove();
    }
    ui.feedEmpty.style.display = 'none';
    return li;
  }
  function addServerFeed(msg) {
    const f = msg.feed || {};
    const li = addFeed(f.kind || 'chat', f.who || '', f.what || '');
    li._fid = msg.fid;
    feedById.set(msg.fid, li);
    if (msg.tag) setTag(li, msg.tag.state, msg.tag.reason);
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
    if (mode === 'browser' || !running) ui.queueLen.textContent = String(tts.queue.length);
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
  function isPaused() {
    return running && mode === 'server' ? serverPaused : tts.paused;
  }
  function updateTitle() {
    let t = 'TikTok TTS';
    if (running) t = (pillState === 'live' ? '🔴 ' : '⏳ ') + t + (isPaused() ? ' (paused)' : '');
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

  function setRunningUI() {
    document.body.classList.toggle('running', running);
    ui.startBtn.textContent = running ? 'Stop' : 'Start';
    ui.startBtn.classList.toggle('stop', running);
    ui.username.disabled = running;
    if (!running) ui.viewers.classList.remove('show');
    updatePauseBtn();
    updateBgStatus();
    updateSpeakNote();
    updateQueue();
  }

  function start() {
    const name = normalizeUsername(ui.username.value);
    if (!name) {
      setStatus('invalid', 'Check username', 'Type your TikTok username, like @yourname.');
      ui.username.focus();
      return;
    }
    mode = phoneWanted() ? 'server' : 'browser';
    if (mode === 'browser' && !hasSpeech) {
      setStatus('error', 'No speech', "This browser can't speak text. Use Chrome or Edge.");
      return;
    }
    S.username = name;
    ui.username.value = name;
    saveSettings();
    running = true;
    lastState = '';
    tts.paused = false;
    if (mode === 'browser') {
      unlockSpeech();
      startKeepAlive();
    }
    setRunningUI();
    setStatus('connecting', 'Connecting…', 'Connecting to @' + name + '…');
    if (socketOpen()) sendJoin();
    else {
      net.retryAt = 0;
      openSocket();
    }
    try {
      sessionStorage.setItem('tiktok-tts-running', mode === 'browser' ? '1' : '');
    } catch (e) {
      /* ignore */
    }
  }

  // The phone is already reading @username: show it here without needing a click.
  function attach(username) {
    S.username = username;
    ui.username.value = username;
    running = true;
    mode = 'server';
    lastState = '';
    setRunningUI();
    setStatus('connecting', 'Connecting…', '');
    sendJoin();
  }

  function stop() {
    sendMsg({ type: mode === 'server' ? 'stop' : 'leave' });
    running = false;
    clearQueue();
    skipCurrent();
    stopKeepAlive();
    setRunningUI();
    setStatus('idle', 'Not running', '');
    try {
      sessionStorage.removeItem('tiktok-tts-running');
    } catch (e) {
      /* ignore */
    }
  }

  function restart() {
    if (!running) return;
    stop();
    start();
  }

  function setPaused(p) {
    if (running && mode === 'server') {
      sendMsg({ type: 'control', action: p ? 'pause' : 'resume' });
      return;
    }
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
    ui.pauseBtn.textContent = isPaused() ? '▶ Resume reading' : '⏸ Pause reading';
  }

  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (running) stop();
    else start();
  });
  ui.pauseBtn.addEventListener('click', () => setPaused(!isPaused()));
  ui.skipBtn.addEventListener('click', () => {
    if (running && mode === 'server') sendMsg({ type: 'control', action: 'skip' });
    else skipCurrent();
  });
  ui.clearBtn.addEventListener('click', () => {
    if (running && mode === 'server') sendMsg({ type: 'control', action: 'clear' });
    else clearQueue();
  });
  ui.testBtn.addEventListener('click', () => {
    const raw = ui.testText.value;
    if ((running ? mode === 'server' : phoneWanted()) && sendMsg({ type: 'control', action: 'test', text: raw })) return;
    if (!hasSpeech) return;
    const item = addFeed('chat', 'Test', raw);
    if (tts.paused) setPaused(false);
    enqueue(B.cleanText(raw, S) || 'Hello!', item, 'test');
  });

  // ---------------------------------------------------------------- settings form binding
  function bindSettings() {
    const defaults = B.defaultsFor(LANG);
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
        else if (el.type === 'number' || el.type === 'range') S[key] = el.value === '' ? defaults[key] : Number(el.value);
        else S[key] = el.value;
        saveSettings();
        show();
        if (key === 'speakOn') {
          updateSpeakNote();
          if (running && (mode === 'server') !== phoneWanted()) restart();
        }
        if (key === 'keepAlive' && running && mode === 'browser') {
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
    if (net.ws && now() - net.lastMsgAt > 40000) {
      dropSocket();
      net.retryAt = 0;
    }
    if (!net.ws) net.retryAt = 0;
    if (running && mode === 'browser' && S.keepAlive && keep.audio && keep.audio.paused) keep.audio.play().catch(() => {});
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
    if (running && mode === 'browser' && S.keepAlive && keep.audio && keep.audio.paused) keep.audio.play().then(updateBgStatus).catch(() => {});
  });
  window.addEventListener('beforeunload', (e) => {
    if (!running || mode !== 'browser') return; // in phone mode closing the page is fine
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
  if (location.protocol === 'file:') {
    setStatus('error', 'Server not running', 'Open this page through the server: run "npm start" (or "tts" in Termux), then go to http://localhost:3000');
  } else if (wasRunning && ui.username.value) {
    setStatus('idle', 'Paused', 'The page was reloaded. Press Start to continue (browsers need one click before they can talk).');
  }
  updateSpeakNote();
  if (ui.username.value) ui.startBtn.focus();
  else ui.username.focus();
  openSocket();

  // Small hook for automated tests.
  window.__tts = {
    S,
    tts,
    net,
    keep,
    get running() {
      return running;
    },
    get mode() {
      return mode;
    },
    get speech() {
      return speech;
    },
  };
})();
