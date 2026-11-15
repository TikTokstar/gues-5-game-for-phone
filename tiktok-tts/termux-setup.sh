#!/data/data/com.termux/files/usr/bin/bash
# One-time setup of TikTok LIVE TTS on an Android phone, inside Termux.
# Paste this into Termux:
#   curl -fsSL https://raw.githubusercontent.com/TikTokstar/gues-5-game-for-phone/ccr-3bcb2e4d-py3d2b/tiktok-tts/termux-setup.sh | bash
# Afterwards just type:  tts
# Also install the "Termux:API" app (same store as Termux): it gives Termux the
# phone's voice, which keeps reading while Chrome is minimized.
# Everything is inside main() so bash reads the whole script before running it
# (needed when it is piped in with curl | bash).
main() {
set -e

  REPO="https://github.com/TikTokstar/gues-5-game-for-phone.git"
  BRANCH="${TTS_BRANCH:-ccr-3bcb2e4d-py3d2b}"
  DIR="$HOME/gues-5-game-for-phone"
  SETUP_URL="https://raw.githubusercontent.com/TikTokstar/gues-5-game-for-phone/$BRANCH/tiktok-tts/termux-setup.sh"

  if [ -z "$PREFIX" ] || [ ! -d "$PREFIX" ]; then
    echo "This script is for Termux on Android."
    exit 1
  fi

  echo
  echo "== 1/3  Installing Node.js, git and the phone voice (a few minutes the first time)..."
  yes | pkg install nodejs-lts git termux-api

  echo
  echo "== 2/3  Downloading TikTok LIVE TTS..."
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch -q --depth 1 origin "$BRANCH"
    git -C "$DIR" checkout -q -B "$BRANCH" FETCH_HEAD
    git -C "$DIR" reset -q --hard FETCH_HEAD
  else
    rm -rf "$DIR"
    git clone -q --depth 1 -b "$BRANCH" "$REPO" "$DIR"
  fi

  echo
  echo "== 3/3  Installing..."
  cd "$DIR/tiktok-tts"
  npm install --omit=dev --no-audit --no-fund

  cat > "$PREFIX/bin/tts" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# tts          start TikTok LIVE TTS and open it in Chrome
# tts @name    start reading @name's LIVE right away with the phone voice (no browser needed)
# tts demo     same as tts, with fake chat for testing
# tts update   download the newest version
if [ "\$1" = "update" ]; then
  curl -fsSL "$SETUP_URL" | bash
  exit
fi
# Wake lock: stops Android from putting Termux to sleep while you stream.
termux-wake-lock 2>/dev/null
trap 'termux-wake-unlock 2>/dev/null' EXIT
cd "$DIR/tiktok-tts" || exit 1
case "\$1" in
  demo) node server.js --demo --open ;;
  "") node server.js --open ;;
  *) node server.js --user "\$1" --open ;;
esac
EOF
  chmod +x "$PREFIX/bin/tts"

  echo
  echo "============================================================"
  echo " Done! From now on just type:   tts"
  echo " (or  tts demo  to test with fake chat first)"
  echo "============================================================"
  echo
  echo " For reading while Chrome is minimized, also install the"
  echo " Termux:API app (from the same store as Termux) and, on"
  echo " Xiaomi/Poco: Settings > Apps > Termux:API > Autostart ON,"
  echo " Battery saver > No restrictions."
  echo
}

main "$@"
