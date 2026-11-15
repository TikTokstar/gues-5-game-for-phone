/* Decides what gets read out for each LIVE event: filters, spam rules, wording.
 * Used by the page (when the browser speaks) and by the server (when the phone
 * speaks through Termux), so both behave the same.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    username: '',
    lang: '',
    speakOn: 'auto', // 'auto' | 'phone' (Termux) | 'browser'
    phoneVoiceLang: '',
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

  const TEMPLATES = {
    en: {
      chatTemplate: '{name} says {text}',
      giftTemplate: '{name} sent {count} {gift}',
      followTemplate: '{name} followed',
      shareTemplate: '{name} shared the live',
      joinTemplate: 'Welcome {name}',
      likeTemplate: '{name} sent likes',
    },
    bg: {
      chatTemplate: '{name} казва {text}',
      giftTemplate: '{name} изпрати {count} {gift}',
      followTemplate: '{name} те последва',
      shareTemplate: '{name} сподели лайва',
      joinTemplate: 'Здравей, {name}',
      likeTemplate: '{name} изпрати сърца',
      phoneVoiceLang: 'bg',
    },
  };

  function langCode(lang) {
    return String(lang || '').toLowerCase().slice(0, 2);
  }

  function defaultsFor(lang) {
    return Object.assign({}, DEFAULTS, TEMPLATES.en, TEMPLATES[langCode(lang)] || {}, { lang: String(lang || '') });
  }

  // Keeps only known settings with the right type (settings also arrive over the network).
  function sanitize(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const k of Object.keys(DEFAULTS)) {
      if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
      const v = input[k];
      const t = typeof DEFAULTS[k];
      if (t === 'number' && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (t === 'boolean' && typeof v === 'boolean') out[k] = v;
      else if (t === 'string' && typeof v === 'string') out[k] = v.slice(0, 2000);
    }
    return out;
  }

  // Saved settings may still hold the English default wording; switch those to the user's language.
  function withDefaults(saved, lang) {
    const d = defaultsFor(lang);
    const s = Object.assign({}, d, sanitize(saved));
    for (const k of Object.keys(TEMPLATES.en)) if (s[k] === TEMPLATES.en[k]) s[k] = d[k];
    return s;
  }

  // ------------------------------------------------------------ text cleanup
  const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}︎️‍⃣]/gu;
  const LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|gg|tv|me|co|ly|xyz|app|link|ru|info|biz|shop|store|live|bg)\b\S*/gi;

  function cleanText(input, S) {
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

  function spokenName(user, S) {
    const uniqueId = (user && user.uniqueId) || '';
    let n = S.nameSource === 'username' ? uniqueId : (user && user.nickname) || uniqueId;
    n = String(n).normalize('NFKC').replace(EMOJI_RE, '').replace(/[^\p{L}\p{N}\s._'-]/gu, ' ');
    if (!/[\p{L}\p{N}]/u.test(n)) n = uniqueId;
    // "gamer_kid.99" -> "gamer kid 99"; drop long number tails like "mila20481234"
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

  function containsBlocked(text, S) {
    const words = listSetting(S.blockedWords);
    if (!words.length) return false;
    return words.some((w) => new RegExp('(^|[^\\p{L}\\p{N}])' + escapeRe(w) + '($|[^\\p{L}\\p{N}])', 'iu').test(text));
  }

  function plural(gift, count) {
    if (count <= 1 || /s$/i.test(gift)) return gift;
    return gift + 's';
  }

  function createMemory() {
    return { recent: new Map(), lastByUser: new Map(), lastLikeByUser: new Map() };
  }

  // Returns null when the event shouldn't even be shown, otherwise
  // { kind, who, what, speak, reason }: speak is the text to say, or null with a reason.
  function decide(ev, S, mem, t) {
    t = t || Date.now();
    const user = (ev && ev.user) || {};
    const uid = String(user.uniqueId || '').toLowerCase();
    const who = user.nickname || user.uniqueId || 'someone';
    const ignored = Boolean(uid) && listSetting(S.ignoredUsers).includes(uid);
    const name = spokenName(user, S);
    const skip = (kind, what, reason) => ({ kind, who, what, speak: null, reason });
    const say = (kind, what, speak) => ({ kind, who, what, speak, reason: null });

    switch (ev && ev.type) {
      case 'chat': {
        const what = String(ev.text || '');
        if (!S.readChat) return skip('chat', what, 'chat off');
        if (ignored) return skip('chat', what, 'ignored');
        const allowed =
          S.who === 'all' ||
          ev.isHost ||
          ev.isMod ||
          (S.who === 'subs' && ev.isSub) ||
          (S.who === 'followers' && (ev.isSub || ev.isFollower));
        if (!allowed) return skip('chat', what, 'not allowed');
        let text = what.trim();
        const prefix = String(S.prefix || '').trim();
        if (prefix) {
          if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return skip('chat', what, 'no ' + prefix);
          text = text.slice(prefix.length).trim();
        } else if (S.skipCommands && /^[!/]/.test(text)) {
          return skip('chat', what, 'command');
        }
        if (containsBlocked(text, S)) return skip('chat', what, 'blocked word');
        text = cleanText(text, S);
        if (!/[\p{L}\p{N}]/u.test(text)) return skip('chat', what, 'nothing to read');
        if (S.skipDuplicates) {
          for (const [k, at] of mem.recent) if (t - at > 60000) mem.recent.delete(k);
          const key = uid + '|' + text.toLowerCase();
          if (mem.recent.has(key)) return skip('chat', what, 'repeat');
          mem.recent.set(key, t);
        }
        const cd = Number(S.userCooldown) || 0;
        if (cd > 0 && uid) {
          if (t - (mem.lastByUser.get(uid) || 0) < cd * 1000) return skip('chat', what, 'cooldown');
          mem.lastByUser.set(uid, t);
        }
        text = truncate(text, S.maxLength);
        return say('chat', what, S.sayNames ? fill(S.chatTemplate || '{name}: {text}', { name, text }) : text);
      }
      case 'gift': {
        const count = Number(ev.count) || 1;
        const what = 'sent ' + (count > 1 ? count + '× ' : '') + ev.gift;
        if (!S.readGifts) return skip('gift', what, 'gifts off');
        if (ignored) return skip('gift', what, 'ignored');
        if ((Number(ev.coins) || 0) < (Number(S.minGiftCoins) || 0)) return skip('gift', what, 'small gift');
        const gift = plural(cleanText(ev.gift, S) || 'a gift', count);
        return say('gift', what, fill(S.giftTemplate, { name, gift, count }));
      }
      case 'follow':
      case 'share': {
        const follow = ev.type === 'follow';
        const what = follow ? 'followed' : 'shared the LIVE';
        if (!(follow ? S.readFollows : S.readShares)) return skip(ev.type, what, 'off');
        if (ignored) return skip(ev.type, what, 'ignored');
        return say(ev.type, what, fill(follow ? S.followTemplate : S.shareTemplate, { name }));
      }
      case 'join':
        if (!S.readJoins || ignored) return null; // too frequent to show when not read
        return say('join', 'joined', fill(S.joinTemplate, { name }));
      case 'like': {
        if (!S.readLikes || ignored) return null;
        if (t - (mem.lastLikeByUser.get(uid) || 0) < 60000) return null; // once a minute per person
        mem.lastLikeByUser.set(uid, t);
        return say('like', 'sent likes', fill(S.likeTemplate, { name, count: ev.count || 1 }));
      }
      default:
        return null;
    }
  }

  root.TTSBrain = {
    DEFAULTS,
    TEMPLATES,
    defaultsFor,
    withDefaults,
    sanitize,
    cleanText,
    truncate,
    spokenName,
    fill,
    listSetting,
    createMemory,
    decide,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
