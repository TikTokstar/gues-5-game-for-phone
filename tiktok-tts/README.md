# TikTok LIVE TTS

Reads your TikTok LIVE chat out loud in your browser. Type your **@username**, press **Start**, and minimize the window. It keeps reading.

- Only needs your @. You don't log in and there are no API keys.
- Keeps running when the browser is minimized or you're in another tab.
- If you're not live yet, it waits and connects as soon as you go live.
- If TikTok or your internet drops, it reconnects by itself.
- Reads chat, gifts and follows. Shares, joins and likes are optional.
- Spam filters: links, emojis, "loooool", !commands, repeated messages, blocked words, ignored users, per-person cooldown, and who's allowed to trigger it (everyone, followers, subs or mods).
- Pick any voice your browser has, and set the speed, pitch and volume.

## On an Android phone (no computer needed)

Everything runs on the phone. **Termux** runs the small server, and **Chrome** reads the chat.

**One-time setup**

1. Install **Termux** from F-Droid (<https://f-droid.org/packages/com.termux/>) or from GitHub (<https://github.com/termux/termux-app/releases>, the `arm64-v8a` .apk). Don't use the old Play Store version.
2. Open Termux, paste this line and press Enter. It takes about 5 minutes.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/TikTokstar/gues-5-game-for-phone/ccr-3bcb2e4d-py3d2b/tiktok-tts/termux-setup.sh | bash
   ```

3. **Xiaomi / Poco / Redmi (HyperOS/MIUI):** these phones close background apps aggressively, so:
   - Go to *Settings → Apps → Manage apps → **Termux** → Battery saver →* **No restrictions**. Do the same for **Chrome**.
   - Open the recent-apps screen, long-press the **Termux** card and tap the 🔒 lock. Do the same for **Chrome**.

**Every stream**

1. Open Termux, type `tts` and press Enter. Chrome opens by itself.
2. Type your @ and press **Start**.
3. Switch to the TikTok app and go LIVE. Termux and Chrome keep running in the background. Don't swipe them away.

Type `tts demo` to test with fake chat first. Type `tts update` to get the newest version.

Before your first real stream, do a test: run `tts demo`, press Start, switch to TikTok and check that it keeps talking. Also check whether viewers hear it (a test LIVE or ask a friend). TikTok's echo cancellation can filter out sound that comes from the phone's own speaker.

## Start it on a computer

You need **Node.js** (free) on the computer you stream from. Get the **LTS** version from <https://nodejs.org>. You only install it once.

**Windows:** double-click **`start.bat`**.
**Mac:** double-click **`start.command`**. If it won't open, right-click it and choose Open.
**Any system (terminal):**

```bash
cd tiktok-tts
npm install
npm start
```

The first start installs what it needs, which takes about a minute. After that your browser opens **http://localhost:3000** by itself.

1. Type your TikTok @ and press **Start**.
2. Minimize the window. Don't close the black server window or the browser tab.

To test without going live, run `start.bat demo`, `./start.command demo` or `npm run demo`. Fake viewers will chat so you can try voices and settings.

## Why it keeps running when minimized

Browsers slow down, freeze or unload tabs that are hidden. The page prevents that:

- It plays an **inaudible tone** (25 Hz, far below what people or speakers can hear), so the browser treats the tab as "playing audio". Chrome and Edge never throttle, freeze or unload an audio tab, and Memory Saver skips it too. You'll see a 🔊 icon on the tab. That's normal.
- Its timers run in a **Web Worker**, which keeps time normally in hidden tabs.
- It holds a **Web Lock** while running. That's another signal browsers use to leave a page alone.
- **Watchdogs** reconnect a dead connection and unstick the browser's speech engine if it hangs, which Chrome sometimes does.
- On **Android**, it shows a media notification that keeps it alive, and you can pause reading from it.

You can turn these off under *Background & minimize*.

> **iPhone/iPad:** iOS pauses web pages in the background, and no website can get around that. Keep the page on screen with *Keep screen on*, or run it on a computer.

## Put the voice on your stream (OBS / TikTok LIVE Studio)

The voice comes out of your computer's normal speakers or headphones. To put it on stream, add your desktop audio, or in OBS an **Application Audio Capture** source for your browser.

## Use it from your phone

When the server starts, its window shows a line like `Open on your phone (same Wi-Fi): http://192.168.x.x:3000`. Open that address on your phone. The computer has to stay on.

## Put it online (optional)

To skip running anything at home, deploy this folder to any Node.js host, such as Render, Railway or a VPS:

- Root directory: `tiktok-tts`
- Build command: `npm install`
- Start command: `npm run serve`

After that, open your site's URL in any browser and type your @. Free hosting plans can go to sleep when nobody uses them, so for long streams running it on your own computer is more reliable.

## Settings

| Section | What you can change |
|---|---|
| Voice | Voice, speed, pitch, volume, and a test button. **Microsoft Edge** has the most natural-sounding voices (they're marked "Natural"). |
| What to read | Chat, gifts, follows, shares, joins and likes. Who can trigger it. Whether to say names. The wording of each message (`{name}`, `{text}`, `{gift}`, `{count}`). Minimum gift value. |
| Filters & spam | Links, emojis, repeated letters, !commands, duplicates, max length, max queue, per-person cooldown, a required prefix (e.g. only read `!tts …`), blocked words and ignored users. |
| Background & minimize | The keep-alive tone and keep screen on. |

Settings are saved in your browser. If too many messages pile up, the oldest chat messages are dropped so the voice never falls minutes behind.

## Troubleshooting

- **"Waiting for LIVE"**: you're not live, or TikTok doesn't see the LIVE yet. It checks again every 30 seconds by itself.
- **"Couldn't connect… retrying"**: check that the @ is right. It retries by itself. TikTok sometimes blocks or rate-limits connections for a few minutes. If that keeps happening, a free API key from [Euler Stream](https://www.eulerstream.com) raises the limits. Start the server with `SIGN_API_KEY=your_key npm start`.
- **No sound**: check the volume slider and the voice, press **▶ Test**, and check which speakers your computer is using. Click the page once. Browsers need one click before a page can make sound.
- **"Port 3000 is already in use"**: it's probably already running in another window. Or start it on another port with `PORT=3001 npm start`.
- **After reloading the page**: press Start again. Browsers need a click before they can talk.

## How it works

TikTok has no official live-chat API, and browsers can't connect to TikTok's live chat directly. So a small Node.js server (`server.js`) uses the open-source [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector) library to join your LIVE as a viewer would. It then sends the chat to the page over a WebSocket. The page reads it with the browser's built-in speech (`speechSynthesis`), so there are no paid voices or accounts.

TikTok can change how its live chat works at any time. If it stops connecting, update the library with `npm update tiktok-live-connector`.

```
tiktok-tts/
  server.js             web server + WebSocket, serves public/
  lib/rooms.js          one TikTok connection per @, retry/reconnect logic
  lib/tiktok-source.js  TikTok → simple chat/gift/follow events
  lib/demo-source.js    fake chat for `npm run demo`
  public/index.html     the page
  public/app.js         speech queue, filters, keep-alive, auto-reconnect
  test/                 `npm test`
```
