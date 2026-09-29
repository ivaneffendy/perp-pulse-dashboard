/**
 * "What drove the price lately" digest — filters the mktnews flash feed down
 * to editorially-important items in a lookback window and formats them for a
 * Telegram reply. On-demand only (no cron, no stored state): every call is a
 * fresh read of whatever the source feed currently holds.
 */

const HOUR = 3600_000;

/**
 * The feed itself is a rolling ~50-item window, not a full history — on a
 * busy news day it can hold far less than the caller's requested `hours`.
 * `spanMs` is computed from ALL in-window items (not just important ones), so
 * it reports how far back the feed actually reached, never overstating
 * coverage the feed didn't have.
 */
export function selectDigest(items, { now, hours }) {
  const windowStart = now - hours * HOUR;
  const inWindow = items.filter((i) => i.ts >= windowStart);
  const spanMs = inWindow.length ? now - Math.min(...inWindow.map((i) => i.ts)) : 0;
  const important = inWindow.filter((i) => i.important).sort((a, b) => b.ts - a.ts);
  return { items: important, spanMs };
}

function fmtSpan(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

const wibFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmtWib = (ts) => `${wibFmt.format(new Date(ts))} WIB`;

/**
 * Truncates to `maxLength` (Telegram hard-rejects messages over 4096 chars)
 * by dropping whole lines from the end and noting how many were cut, rather
 * than cutting mid-line into unreadable partial text.
 */
export function formatDigestMessage({ items, spanMs }, { hours, maxLength = 4096 }) {
  const span = fmtSpan(spanMs);
  if (!items.length) {
    return `No important flashes in the last ${span} (asked for ${hours}h — that's what the feed's rolling window currently holds).`;
  }
  const header = `${items.length} important flash${items.length === 1 ? '' : 'es'}, last ${span}:`;
  const lines = items.map((i) => `• ${fmtWib(i.ts)} — ${i.content}`);

  let kept = lines.length;
  let msg = [header, ...lines].join('\n');
  while (msg.length > maxLength && kept > 0) {
    kept -= 1;
    const cut = lines.length - kept;
    msg = [header, ...lines.slice(0, kept), `…and ${cut} more`].join('\n');
  }
  return msg;
}
