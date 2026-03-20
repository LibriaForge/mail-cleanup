import fetch from 'node-fetch';
import ora from 'ora';
import chalk from 'chalk';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
// Graph API supports $top up to 1000 for messages
const PAGE_SIZE = 1000;
// Graph JSON batch supports up to 20 requests per call
const GRAPH_BATCH_SIZE = 20;

/**
 * Make an authenticated request to Microsoft Graph.
 */
async function graphRequest(accessToken, path, options = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch { /* ignore */ }
    throw new Error(`Graph API error ${res.status} on ${path}: ${errBody}`);
  }

  // 204 No Content — nothing to parse
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Fetch all unread messages from the inbox, page by page.
 * Returns an array of { id, from, subject }.
 *
 * @param {string} accessToken
 * @param {object} spinner - ora spinner
 * @param {string|undefined} from  - optional ISO date string (YYYY-MM-DD); only fetch emails on or after this date
 * @param {string|undefined} to    - optional ISO date string (YYYY-MM-DD); only fetch emails on or before this date
 * @param {boolean} inbox          - if true, only fetch emails from the inbox folder
 */
async function fetchAllMessages(accessToken, spinner, from, to, inbox) {
  // Get Deleted Items folder ID so we can exclude it
  let deletedItemsId = null;
  try {
    const folder = await graphRequest(accessToken, '/me/mailFolders/deleteditems?$select=id');
    deletedItemsId = folder?.id ?? null;
  } catch { /* ignore — just won't exclude deleted items */ }

  const filterParts = [];
  if (deletedItemsId) {
    filterParts.push(`parentFolderId ne '${deletedItemsId}'`);
  }
  if (from) {
    filterParts.push(`receivedDateTime ge ${from}T00:00:00Z`);
  }
  if (to) {
    filterParts.push(`receivedDateTime le ${to}T23:59:59Z`);
  }

  const filterStr = filterParts.length > 0 ? filterParts.join(' and ') : null;

  const messages = [];
  const basePath = inbox ? '/me/mailFolders/inbox/messages' : '/me/messages';
  const query = filterStr
    ? `?$filter=${encodeURIComponent(filterStr)}&$select=id,from,subject&$top=50`
    : `?$select=id,from,subject&$top=50`;
  let nextUrl = `${GRAPH_BASE}${basePath}${query}`;

  let page = 0;
  while (nextUrl) {
    page++;
    spinner.text = chalk.cyan(
      `Fetching Outlook messages — page ${page} (${messages.length.toLocaleString()} so far)…`
    );

    const data = await graphRequest(accessToken, nextUrl);
    const batch = data?.value ?? [];
    messages.push(...batch);
    nextUrl = data?.['@odata.nextLink'] ?? null;
  }

  return messages;
}

/**
 * Fetch all unread Outlook emails and group them by sender email address.
 * Returns an array of { email, name, count, subjects, ids } sorted by count desc.
 *
 * @param {string} accessToken
 * @param {object} [options]
 * @param {string} [options.from]   - ISO date string (YYYY-MM-DD); only include emails on or after this date
 * @param {string} [options.to]     - ISO date string (YYYY-MM-DD); only include emails on or before this date
 * @param {boolean} [options.inbox] - if true, only fetch emails from the inbox folder
 * @param {string[]} [options.excludeIds] - message IDs to exclude (already processed in a previous session)
 */
export async function fetchAndGroupEmails(accessToken, options = {}) {
  const { from, to, inbox = false, excludeIds = [] } = options;

  // Decode JWT claims (no verification, just inspection)
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
    console.log(chalk.gray(`Token aud: ${payload.aud}`));
    console.log(chalk.gray(`Token scp: ${payload.scp ?? payload.roles ?? '(none)'}`));
  } catch { /* ignore */ }

  const spinner = ora({ text: chalk.cyan('Connecting to Outlook…'), color: 'cyan' }).start();

  try {
    const allMessages = await fetchAllMessages(accessToken, spinner, from, to, inbox);

    // Filter out already-processed IDs (checkpoint resume)
    const excludeSet = new Set(excludeIds);
    const messages = excludeIds.length > 0
      ? allMessages.filter((m) => !excludeSet.has(m.id))
      : allMessages;

    if (messages.length === 0) {
      spinner.succeed(chalk.green('No unread emails found in Outlook inbox.'));
      return [];
    }

    spinner.text = chalk.cyan(`Grouping ${messages.length.toLocaleString()} messages by sender…`);

    const senderMap = new Map();

    for (const msg of messages) {
      const email = (msg.from?.emailAddress?.address ?? 'unknown').toLowerCase().trim();
      const name = msg.from?.emailAddress?.name ?? email;
      const subject = msg.subject ?? '(no subject)';

      if (!senderMap.has(email)) {
        senderMap.set(email, { name, subjects: [], ids: [] });
      }
      const entry = senderMap.get(email);
      if (entry.subjects.length < 5) entry.subjects.push(subject);
      entry.ids.push(msg.id);
    }

    spinner.succeed(
      chalk.green(
        `Loaded ${messages.length.toLocaleString()} unread emails from ${senderMap.size.toLocaleString()} senders.`
      )
    );

    const groups = [];
    for (const [email, data] of senderMap) {
      groups.push({
        email,
        name: data.name,
        count: data.ids.length,
        subjects: data.subjects,
        ids: data.ids,
      });
    }
    groups.sort((a, b) => b.count - a.count);
    return groups;
  } catch (err) {
    spinner.fail(chalk.red('Failed to fetch Outlook messages.'));
    throw err;
  }
}

/**
 * Send a Graph JSON batch request.
 * Each request in the batch must have: id, method, url, (optional) body, headers.
 */
async function sendBatch(accessToken, requests) {
  const body = JSON.stringify({ requests });
  const result = await graphRequest(accessToken, '/\$batch', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  });

  const SUCCESS = new Set([200, 201, 202, 204]);
  const failed = (result?.responses ?? []).filter((r) => !SUCCESS.has(r.status));
  if (failed.length > 0) {
    const first = failed[0];
    console.warn(
      chalk.yellow(
        `  Warning: ${failed.length} batch sub-request(s) failed.\n` +
        `  First failure — status ${first.status}, id ${first.id}:\n` +
        `  ${JSON.stringify(first.body ?? '')}`
      )
    );
  }
}

/**
 * Permanently delete a list of message IDs using Graph batch requests.
 */
export async function deleteEmails(accessToken, ids) {
  if (ids.length === 0) return;

  for (let i = 0; i < ids.length; i += GRAPH_BATCH_SIZE) {
    const chunk = ids.slice(i, i + GRAPH_BATCH_SIZE);
    const requests = chunk.map((id, idx) => ({
      id: String(idx + 1),
      method: 'DELETE',
      url: `/me/messages/${encodeURIComponent(id)}`,
    }));
    await sendBatch(accessToken, requests);
  }
}

/**
 * Archive a list of message IDs by moving them to the Archive folder
 * and marking them as read, using Graph batch requests.
 */
export async function archiveEmails(accessToken, ids) {
  if (ids.length === 0) return;

  // Resolve the archive folder ID once
  let archiveFolderId;
  try {
    const res = await graphRequest(accessToken, '/me/mailFolders/archive');
    archiveFolderId = res?.id;
  } catch {
    // Some tenants use "Archive" (capital A)
    try {
      const res = await graphRequest(accessToken, '/me/mailFolders/Archive');
      archiveFolderId = res?.id;
    } catch {
      archiveFolderId = null;
    }
  }

  for (let i = 0; i < ids.length; i += GRAPH_BATCH_SIZE) {
    const chunk = ids.slice(i, i + GRAPH_BATCH_SIZE);

    const requests = chunk.flatMap((id, idx) => {
      const reqs = [];
      const base = idx * 2;

      // Mark as read
      reqs.push({
        id: String(base + 1),
        method: 'PATCH',
        url: `/me/messages/${encodeURIComponent(id)}`,
        headers: { 'Content-Type': 'application/json' },
        body: { isRead: true },
      });

      // Move to archive folder if we have it, otherwise just mark read
      if (archiveFolderId) {
        reqs.push({
          id: String(base + 2),
          method: 'POST',
          url: `/me/messages/${encodeURIComponent(id)}/move`,
          headers: { 'Content-Type': 'application/json' },
          body: { destinationId: archiveFolderId },
        });
      }

      return reqs;
    });

    // Graph batch max is 20 — split if archiving doubles request count
    for (let j = 0; j < requests.length; j += GRAPH_BATCH_SIZE) {
      await sendBatch(accessToken, requests.slice(j, j + GRAPH_BATCH_SIZE));
    }
  }
}

// Folder ID cache to avoid repeated API calls within a session
const folderIdCache = new Map();

/** Get or create a named child folder under Inbox. Returns folder ID. */
export async function getOrCreateFolder(accessToken, name) {
  if (folderIdCache.has(name)) return folderIdCache.get(name);
  const res = await graphRequest(accessToken, '/me/mailFolders/inbox/childFolders?$select=id,displayName&$top=200');
  const existing = (res?.value ?? []).find((f) => f.displayName === name);
  if (existing) { folderIdCache.set(name, existing.id); return existing.id; }
  const created = await graphRequest(accessToken, '/me/mailFolders/inbox/childFolders', {
    method: 'POST',
    body: JSON.stringify({ displayName: name }),
  });
  folderIdCache.set(name, created.id);
  return created.id;
}

/** Move messages to a named folder (creates if needed) using Graph batch. */
export async function moveToFolder(accessToken, ids, folderName) {
  if (ids.length === 0) return;
  const folderId = await getOrCreateFolder(accessToken, folderName);
  for (let i = 0; i < ids.length; i += GRAPH_BATCH_SIZE) {
    const chunk = ids.slice(i, i + GRAPH_BATCH_SIZE);
    const requests = chunk.map((id, idx) => ({
      id: String(idx + 1),
      method: 'POST',
      url: `/me/messages/${encodeURIComponent(id)}/move`,
      headers: { 'Content-Type': 'application/json' },
      body: { destinationId: folderId },
    }));
    await sendBatch(accessToken, requests);
  }
}

/** Move messages to the Junk Email folder using Graph batch. */
export async function markAsSpam(accessToken, ids) {
  if (ids.length === 0) return;
  const res = await graphRequest(accessToken, '/me/mailFolders/junkemail?$select=id');
  const junkId = res?.id;
  if (!junkId) return;
  for (let i = 0; i < ids.length; i += GRAPH_BATCH_SIZE) {
    const chunk = ids.slice(i, i + GRAPH_BATCH_SIZE);
    const requests = chunk.map((id, idx) => ({
      id: String(idx + 1),
      method: 'POST',
      url: `/me/messages/${encodeURIComponent(id)}/move`,
      headers: { 'Content-Type': 'application/json' },
      body: { destinationId: junkId },
    }));
    await sendBatch(accessToken, requests);
  }
}

/**
 * Fetch the body of a single message for unsubscribe link scanning.
 * Body is used transiently — never stored. Returns string or null.
 */
export async function fetchBodyForUnsubscribe(accessToken, messageId) {
  try {
    const res = await graphRequest(accessToken, `/me/messages/${encodeURIComponent(messageId)}?$select=body`);
    return res?.body?.content ?? null;
  } catch {
    return null;
  }
}

/** Fetch List-Unsubscribe header from a single message via Graph. */
export async function fetchListUnsubscribe(accessToken, messageId) {
  try {
    const res = await graphRequest(accessToken, `/me/messages/${encodeURIComponent(messageId)}?$select=internetMessageHeaders`);
    const headers = res?.internetMessageHeaders ?? [];
    const headerValue = headers.find((h) => h.name.toLowerCase() === 'list-unsubscribe')?.value ?? null;
    const postHeader = headers.find((h) => h.name.toLowerCase() === 'list-unsubscribe-post')?.value ?? null;
    return { headerValue, hasOneClick: postHeader?.toLowerCase().includes('one-click') ?? false };
  } catch {
    return { headerValue: null, hasOneClick: false };
  }
}
