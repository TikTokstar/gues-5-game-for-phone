// Wraps tiktok-live-connector and turns its raw TikTok messages into small,
// plain objects the browser page understands:
//   { type: 'chat' | 'gift' | 'follow' | 'share' | 'join' | 'like' | 'viewers', ... }
import { EventEmitter } from 'node:events';
import {
  TikTokLiveConnection,
  WebcastEvent,
  ControlEvent,
  UserOfflineError,
  SignatureRateLimitError,
} from 'tiktok-live-connector';
import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent';

// Optional: an Euler Stream API key raises the free signing rate limits.
// Not needed for normal use.
const SIGN_API_KEY = process.env.SIGN_API_KEY || undefined;

// Optional: route TikTok traffic through an HTTP(S) proxy (TTS_PROXY, or the
// usual HTTPS_PROXY). The TikTok library ignores proxy settings unless told.
const PROXY = process.env.TTS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '';
function proxyOptions() {
  if (!PROXY) return {};
  return {
    webClientOptions: {
      agent: {
        http: new HttpProxyAgent({ proxy: PROXY, keepAlive: true }),
        https: new HttpsProxyAgent({ proxy: PROXY, keepAlive: true }),
      },
    },
    wsClientOptions: { agent: new HttpsProxyAgent({ proxy: PROXY, keepAlive: true }) },
  };
}

function userOf(data) {
  const u = data?.user || {};
  return {
    uniqueId: String(u.uniqueId || data?.uniqueId || ''),
    nickname: String(u.nickname || data?.nickname || ''),
  };
}

function idOf(data) {
  const id = data?.common?.msgId ?? data?.msgId;
  return id === undefined || id === null ? '' : String(id);
}

function rolesOf(data) {
  const i = data?.userIdentity || {};
  return {
    isMod: Boolean(i.isModeratorOfAnchor),
    isSub: Boolean(i.isSubscriberOfAnchor),
    isFollower: Boolean(i.isFollowerOfAnchor || i.isMutualFollowingWithAnchor),
    isHost: Boolean(i.isAnchor),
  };
}

export class TikTokSource extends EventEmitter {
  constructor(username) {
    super();
    this.username = username;
    this.conn = null;
  }

  async connect() {
    const conn = new TikTokLiveConnection(this.username, {
      // Don't replay old chat from before we connected, or it would all be read out at once.
      processInitialData: false,
      signApiKey: SIGN_API_KEY,
      ...proxyOptions(),
    });
    this.conn = conn;
    const send = (ev) => this.emit('event', ev);

    conn.on(WebcastEvent.CHAT, (d) => {
      send({
        type: 'chat',
        id: idOf(d),
        user: userOf(d),
        text: String(d?.comment ?? d?.content ?? ''),
        ...rolesOf(d),
      });
    });

    conn.on(WebcastEvent.GIFT, (d) => {
      const g = d?.giftDetails || {};
      // Streakable gifts (giftType 1) fire on every tap; only announce the final total.
      if (g.giftType === 1 && !d?.repeatEnd) return;
      const count = Number(d?.repeatCount) || 1;
      send({
        type: 'gift',
        id: idOf(d),
        user: userOf(d),
        gift: String(g.giftName || d?.extendedGiftInfo?.name || 'a gift'),
        count,
        coins: (Number(g.diamondCount) || 0) * count,
        ...rolesOf(d),
      });
    });

    conn.on(WebcastEvent.FOLLOW, (d) => send({ type: 'follow', id: idOf(d), user: userOf(d) }));
    conn.on(WebcastEvent.SHARE, (d) => send({ type: 'share', id: idOf(d), user: userOf(d) }));
    conn.on(WebcastEvent.MEMBER, (d) => send({ type: 'join', id: idOf(d), user: userOf(d) }));
    conn.on(WebcastEvent.LIKE, (d) =>
      send({
        type: 'like',
        id: idOf(d),
        user: userOf(d),
        count: Number(d?.likeCount) || 1,
        total: Number(d?.totalLikeCount) || 0,
      }),
    );
    conn.on(WebcastEvent.ROOM_USER, (d) =>
      send({ type: 'viewers', count: Number(d?.viewerCount) || 0 }),
    );

    conn.on(WebcastEvent.STREAM_END, () => this.emit('streamEnd'));
    conn.on(ControlEvent.DISCONNECTED, (info) => this.emit('disconnected', info?.reason || ''));
    // An 'error' event with no listener would crash the whole server.
    conn.on(ControlEvent.ERROR, (e) => {
      const msg = e?.exception?.message || e?.info || e?.message || e;
      console.warn(`[@${this.username}] TikTok error:`, String(msg).slice(0, 300));
    });

    const state = await conn.connect();
    return { roomId: state?.roomId ? String(state.roomId) : '' };
  }

  async disconnect() {
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    conn.removeAllListeners();
    conn.on('error', () => {});
    try {
      await Promise.race([conn.disconnect(), new Promise((r) => setTimeout(r, 5000))]);
    } catch {
      // already closed
    }
  }
}

// Sorts connection failures into the few cases the page shows differently.
export function classifyError(err) {
  const message = String(err?.message || err || 'Unknown error');
  if (err instanceof UserOfflineError || /offline|isn't online|not online|not live/i.test(message)) {
    return { kind: 'offline', message };
  }
  if (err instanceof SignatureRateLimitError || /rate.?limit|too many requests|429/i.test(message)) {
    return { kind: 'ratelimit', message };
  }
  return { kind: 'error', message };
}
