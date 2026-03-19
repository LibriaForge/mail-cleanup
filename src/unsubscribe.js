import fetch from 'node-fetch';

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

/**
 * Execute an unsubscribe. Returns { success, method, detail }.
 * hasOneClick = true when List-Unsubscribe-Post header is present.
 */
export async function executeUnsubscribe(parsed, hasOneClick = false) {
  if (!parsed) return { success: false, method: null, detail: 'No unsubscribe info found.' };

  if (parsed.urls.length > 0 && hasOneClick) {
    try {
      const res = await fetch(parsed.urls[0], {
        method: 'POST',
        body: 'List-Unsubscribe=One-Click',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (res.ok) return { success: true, method: 'POST (one-click)', detail: parsed.urls[0] };
    } catch { /* fall through */ }
  }

  if (parsed.urls.length > 0) {
    try {
      const res = await fetch(parsed.urls[0], { method: 'GET' });
      if (res.ok) return { success: true, method: 'GET', detail: parsed.urls[0] };
    } catch { /* fall through */ }
  }

  if (parsed.mailto.length > 0) {
    return { success: false, method: 'mailto', detail: parsed.mailto[0] };
  }

  return { success: false, method: null, detail: 'All unsubscribe methods failed.' };
}
