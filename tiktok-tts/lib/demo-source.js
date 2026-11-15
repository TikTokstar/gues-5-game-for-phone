// Fake TikTok LIVE used by `npm run demo`, so you can try voices and settings
// without going live. Emits the same event shapes as TikTokSource.
import { EventEmitter } from 'node:events';

const USERS = [
  ['sunny.days', 'Sunny ☀️'],
  ['gamer_kid_99', '𝓖𝓪𝓶𝓮𝓻 Kid'],
  ['mila.art', 'Mila'],
  ['bigtom', 'Big Tom'],
  ['noodle_queen', 'Noodle Queen 🍜'],
];
const CHAT = [
  'hello from Brazil!',
  'how long have you been streaming?',
  'loooooooool 😂😂😂',
  'what game is this',
  'check out https://example.com free coins',
  'you are so funny',
  '!points',
  'can you say hi to my mom',
  'first time here, love the vibes',
  'GG',
];
const GIFTS = [['Rose', 1], ['TikTok', 1], ['Finger Heart', 5], ['Galaxy', 1000]];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export class DemoSource extends EventEmitter {
  constructor(username) {
    super();
    this.username = username;
    this.timer = null;
    this.n = 0;
  }

  async connect() {
    await new Promise((r) => setTimeout(r, 400));
    this.timer = setInterval(() => this.tick(), 2500);
    return { roomId: 'demo' };
  }

  tick() {
    const [uniqueId, nickname] = pick(USERS);
    const user = { uniqueId, nickname };
    const id = `demo-${++this.n}`;
    const r = Math.random();
    if (r < 0.65) this.emit('event', { type: 'chat', id, user, text: pick(CHAT), isMod: false, isSub: false, isFollower: r < 0.3, isHost: false });
    else if (r < 0.8) {
      const [gift, coins] = pick(GIFTS);
      const count = 1 + Math.floor(Math.random() * 5);
      this.emit('event', { type: 'gift', id, user, gift, count, coins: coins * count });
    } else if (r < 0.88) this.emit('event', { type: 'follow', id, user });
    else if (r < 0.94) this.emit('event', { type: 'join', id, user });
    else this.emit('event', { type: 'share', id, user });
    if (this.n % 4 === 0) this.emit('event', { type: 'viewers', count: 20 + Math.floor(Math.random() * 30) });
  }

  async disconnect() {
    clearInterval(this.timer);
    this.timer = null;
    this.removeAllListeners();
  }
}
