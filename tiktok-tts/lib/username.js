// Turns whatever the user typed ("@name", "name", "https://www.tiktok.com/@name/live")
// into a bare TikTok username, or returns null if it can't be a valid one.
export function normalizeUsername(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const fromUrl = s.match(/tiktok\.com\/@([^/?#\s]+)/i);
  if (fromUrl) s = fromUrl[1];
  s = s.replace(/^@+/, '').trim().toLowerCase();
  // TikTok usernames: letters, numbers, underscores and periods, max 24 characters.
  return /^[a-z0-9._]{1,24}$/.test(s) ? s : null;
}
