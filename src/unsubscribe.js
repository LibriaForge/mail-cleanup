import { exec } from 'child_process';

/**
 * Parse a List-Unsubscribe header value.
 * Returns { urls: string[], mailto: string[] } or null.
 */
export function parseUnsubscribeHeader(headerValue) {
  if (!headerValue) return null;
  const urls = [], mailto = [];
  for (const part of headerValue.split(',')) {
    const m = part.trim().match(/^<(.+)>$/);
    if (!m) continue;
    const val = m[1].trim();
    if (val.startsWith('mailto:')) mailto.push(val.slice(7));
    else if (val.startsWith('http')) urls.push(val);
  }
  if (urls.length === 0 && mailto.length === 0) return null;
  return { urls, mailto };
}

// Matches common unsubscribe-related path/query patterns
const UNSUB_PATTERN = /unsub|opt[\s_-]?out|remove.*list|list.*remov/i;

// Matches href attributes in HTML
const HREF_RE = /href=["']([^"'#][^"']*?)["']/gi;

// Matches full <a> tags to check visible text
const LINK_RE = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Scan an HTML (or plain-text) email body for unsubscribe links.
 * Checks both the URL itself and the visible link text.
 * Returns the best candidate URL or null.
 */
export function extractUnsubscribeFromBody(body) {
  if (!body) return null;
  // Unsubscribe links are almost always at the bottom — scan last 500 chars only
  const tail = body.length > 500 ? body.slice(-500) : body;
  const candidates = new Set();

  // URLs whose href contains an unsubscribe keyword
  HREF_RE.lastIndex = 0;
  let m;
  while ((m = HREF_RE.exec(tail)) !== null) {
    const url = m[1];
    if (url.startsWith('http') && UNSUB_PATTERN.test(url)) candidates.add(url);
  }

  // <a> tags whose visible text contains an unsubscribe keyword
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(tail)) !== null) {
    const url = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (url.startsWith('http') && UNSUB_PATTERN.test(text) && !candidates.has(url)) {
      candidates.add(url);
    }
  }

  return candidates.size > 0 ? [...candidates][0] : null;
}

/** Open a URL in the system's default browser. */
function openInBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
}

/**
 * Execute an unsubscribe. Returns { success, method, detail }.
 * hasOneClick = true when List-Unsubscribe-Post header is present (RFC 8058 one-click).
 */
export async function executeUnsubscribe(parsed, hasOneClick = false) {
  if (!parsed) return { success: false, method: null, detail: 'No unsubscribe info found.' };

  // RFC 8058 one-click POST — designed for programmatic use, no browser needed
  if (parsed.urls.length > 0 && hasOneClick) {
    try {
      const res = await fetch(parsed.urls[0], {
        method: 'POST',
        body: 'List-Unsubscribe=One-Click',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (res.ok) return { success: true, method: 'one-click POST', detail: parsed.urls[0] };
    } catch { /* fall through to browser */ }
  }

  // All other URLs — open in browser so the user can confirm on the sender's page
  if (parsed.urls.length > 0) {
    openInBrowser(parsed.urls[0]);
    return { success: true, method: 'browser', detail: parsed.urls[0] };
  }

  if (parsed.mailto.length > 0) {
    return { success: false, method: 'mailto', detail: parsed.mailto[0] };
  }

  return { success: false, method: null, detail: 'No unsubscribe method available.' };
}
