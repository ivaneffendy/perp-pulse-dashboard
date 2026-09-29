/**
 * mktnews.com's flash feed — a real-time market/macro news terminal. The
 * page at mktnews.com/flash.html itself reads this exact JSON from its own
 * CDN, unauthenticated: no API key, no documented rate limit or ToS for this
 * endpoint specifically (unofficial, same risk class as the Farside scrape in
 * macro.js — could change or block at any time).
 *
 * Verified live 2026-09-28: the `important` flag caught the oil/yields/Fed
 * story that was actually driving crypto that day, with no crypto-specific
 * tag needed — that's why the digest filters on `important` alone rather
 * than a category allowlist.
 *
 * Rolling window only (~50 items) — NOT a full history. On a busy news day
 * that can be under an hour of coverage; compute/digest.js reports the
 * actual span it saw rather than assuming the requested lookback was met.
 */
export const MKTNEWS_URL = 'https://static.mktnews.net/json/flash/en.json';

export function normalizeFlashes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const ts = Date.parse(item?.time);
      const content = item?.data?.content;
      if (!Number.isFinite(ts) || typeof content !== 'string' || !content) return null;
      return { id: item.id, ts, important: item.important === 1, content };
    })
    .filter(Boolean);
}

export async function fetchFlashes(j) {
  const raw = await j(MKTNEWS_URL);
  return normalizeFlashes(raw);
}
