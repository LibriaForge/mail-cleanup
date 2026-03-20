import { google } from 'googleapis';
import ora from 'ora';
import chalk from 'chalk';

// How many message IDs to fetch per page
const PAGE_SIZE = 500;
// How many message metadata requests to run in parallel
const METADATA_BATCH_SIZE = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a Gmail API call with exponential backoff on quota/rate-limit errors.
 */
async function withRetry(fn, maxRetries = 6) {
  let delay = 1500;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err.message ?? '';
      const isQuota =
        msg.includes('Quota exceeded') ||
        msg.includes('rateLimitExceeded') ||
        msg.includes('userRateLimitExceeded') ||
        err.code === 429 ||
        err.status === 429 ||
        err.status === 403;

      if (isQuota && attempt < maxRetries) {
        console.log(chalk.yellow(`  Rate limited — waiting ${delay / 1000}s before retry (${attempt + 1}/${maxRetries})…`));
        await sleep(delay);
        delay = Math.min(delay * 2, 60000); // cap at 60s
      } else {
        throw err;
      }
    }
  }
}

/**
 * Parse a From header value into { name, email }.
 * Handles both "Display Name <email@example.com>" and bare "email@example.com".
 */
function parseFrom(fromHeader) {
  if (!fromHeader) return { name: 'Unknown', email: 'unknown' };

  const match = fromHeader.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].replace(/^["']|["']$/g, '').trim() || match[2],
      email: match[2].toLowerCase().trim(),
    };
  }
  const bare = fromHeader.trim().toLowerCase();
  return { name: bare, email: bare };
}

/**
 * Fetch all unread message IDs from Gmail.
 *
 * @param {object} gmail - authenticated Gmail client
 * @param {object} spinner - ora spinner
 * @param {string|undefined} from  - optional ISO date string (YYYY-MM-DD); only fetch emails on or after this date
 * @param {string|undefined} to    - optional ISO date string (YYYY-MM-DD); only fetch emails on or before this date
 * @param {boolean} inbox          - if true, only fetch emails in the inbox
 */
async function fetchAllMessageIds(gmail, spinner, from, to, inbox) {
  const ids = [];
  let pageToken;
  let page = 0;

  const pad = (n) => String(n).padStart(2, '0');
  const toGmailDate = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;

  // Build the query string
  let query = inbox ? 'in:inbox' : 'in:all -in:trash';
  if (from) {
    // Gmail's after: operator is exclusive, so subtract one day to make it inclusive.
    const d = new Date(from);
    d.setDate(d.getDate() - 1);
    query += ` after:${toGmailDate(d)}`;
  }
  if (to) {
    // Gmail's before: operator is exclusive, so add one day to make it inclusive.
    const d = new Date(to);
    d.setDate(d.getDate() + 1);
    query += ` before:${toGmailDate(d)}`;
  }

  do {
    page++;
    spinner.text = chalk.cyan(`Fetching message list — page ${page} (${ids.length.toLocaleString()} IDs so far)…`);

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: PAGE_SIZE,
      pageToken,
      fields: 'messages(id),nextPageToken',
    });

    const messages = res.data.messages ?? [];
    ids.push(...messages.map((m) => m.id));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return ids;
}

/**
 * Fetch metadata (From, Subject) for a batch of message IDs.
 */
async function fetchMetadataBatch(gmail, ids) {
  const results = await Promise.allSettled(
    ids.map((id) =>
      gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject'],
        fields: 'id,labelIds,payload/headers',
      })
    )
  );

  return results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value.data);
}

/**
 * Fetch all unread emails and group them by sender.
 * Returns an array of { email, name, count, subjects, ids } sorted by count desc.
 *
 * @param {object} auth - authenticated OAuth2 client
 * @param {object} [options]
 * @param {string} [options.from]  - ISO date string (YYYY-MM-DD); only include emails on or after this date
 * @param {string} [options.to]    - ISO date string (YYYY-MM-DD); only include emails on or before this date
 * @param {boolean} [options.inbox] - if true, only fetch emails in the inbox
 * @param {string[]} [options.excludeIds] - message IDs to exclude (already processed in a previous session)
 */
export async function fetchAndGroupEmails(auth, options = {}) {
  const { from, to, inbox = false, excludeIds = [] } = options;
  const gmail = google.gmail({ version: 'v1', auth });
  const spinner = ora({ text: chalk.cyan('Connecting to Gmail…'), color: 'cyan' }).start();

  try {
    // Step 1: Get all message IDs
    const allIds = await fetchAllMessageIds(gmail, spinner, from, to, inbox);

    // Filter out already-processed IDs (checkpoint resume)
    const excludeSet = new Set(excludeIds);
    const filteredIds = excludeIds.length > 0 ? allIds.filter((id) => !excludeSet.has(id)) : allIds;

    spinner.text = chalk.cyan(`Fetched ${filteredIds.length.toLocaleString()} message IDs. Loading metadata…`);

    if (filteredIds.length === 0) {
      spinner.succeed(chalk.green('No unread emails found in Gmail.'));
      return [];
    }

    // Step 2: Fetch metadata in batches
    const senderMap = new Map(); // email → { name, subjects: [], ids: [] }
    let processed = 0;

    for (let i = 0; i < filteredIds.length; i += METADATA_BATCH_SIZE) {
      const batch = filteredIds.slice(i, i + METADATA_BATCH_SIZE);
      const messages = await fetchMetadataBatch(gmail, batch);

      for (const msg of messages) {
        const headers = msg.payload?.headers ?? [];
        const fromHeader = headers.find((h) => h.name === 'From')?.value ?? '';
        const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(no subject)';

        const { name, email } = parseFrom(fromHeader);

        if (!senderMap.has(email)) {
          senderMap.set(email, { name, subjects: [], ids: [] });
        }
        const entry = senderMap.get(email);
        if (entry.subjects.length < 5) entry.subjects.push(subject);
        entry.ids.push(msg.id);
      }

      processed += batch.length;
      spinner.text = chalk.cyan(
        `Loading metadata: ${processed.toLocaleString()} / ${filteredIds.length.toLocaleString()} emails processed…`
      );
    }

    spinner.succeed(
      chalk.green(
        `Loaded ${filteredIds.length.toLocaleString()} unread emails from ${senderMap.size.toLocaleString()} senders.`
      )
    );

    // Step 3: Convert map to sorted array
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
    spinner.fail(chalk.red('Failed to fetch Gmail messages.'));
    throw err;
  }
}

/**
 * Permanently delete all messages in the given ID list using batchDelete.
 * Gmail batchDelete accepts up to 1000 IDs per request.
 */
export async function deleteEmails(auth, ids) {
  if (ids.length === 0) return;
  const gmail = google.gmail({ version: 'v1', auth });
  const CHUNK = 1000;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await withRetry(() =>
      gmail.users.messages.batchDelete({
        userId: 'me',
        requestBody: { ids: chunk },
      })
    );
    if (i + CHUNK < ids.length) await sleep(500);
  }
}

/**
 * Archive all messages in the given ID list (remove INBOX label).
 * Uses batchModify which accepts up to 1000 IDs per request.
 */
export async function archiveEmails(auth, ids) {
  if (ids.length === 0) return;
  const gmail = google.gmail({ version: 'v1', auth });
  const CHUNK = 1000;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await withRetry(() =>
      gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: chunk,
          removeLabelIds: ['INBOX', 'UNREAD'],
        },
      })
    );
    if (i + CHUNK < ids.length) await sleep(500);
  }
}

/** Get or create a Gmail label by name. Returns the label ID. */
export async function getOrCreateLabel(auth, name) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await withRetry(() => gmail.users.labels.list({ userId: 'me' }));
  const existing = (res.data.labels ?? []).find((l) => l.name === name);
  if (existing) return existing.id;
  const created = await withRetry(() =>
    gmail.users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    })
  );
  return created.data.id;
}

/** Move messages to a named label (creates if needed). Removes INBOX + UNREAD. */
export async function moveToFolder(auth, ids, folderName) {
  if (ids.length === 0) return;
  const gmail = google.gmail({ version: 'v1', auth });
  const labelId = await getOrCreateLabel(auth, folderName);
  const CHUNK = 1000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await withRetry(() =>
      gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: { ids: chunk, addLabelIds: [labelId], removeLabelIds: ['INBOX', 'UNREAD'] },
      })
    );
    if (i + CHUNK < ids.length) await sleep(500);
  }
}

/** Move messages to the Spam folder and remove INBOX/UNREAD labels. */
export async function markAsSpam(auth, ids) {
  if (ids.length === 0) return;
  const gmail = google.gmail({ version: 'v1', auth });
  const CHUNK = 1000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await withRetry(() =>
      gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: { ids: chunk, addLabelIds: ['SPAM'], removeLabelIds: ['INBOX', 'UNREAD'] },
      })
    );
    if (i + CHUNK < ids.length) await sleep(500);
  }
}

/**
 * Recursively extract the first usable body (text/html preferred, text/plain fallback)
 * from a Gmail MIME payload tree. Returns a decoded string or null.
 */
function extractBody(payload) {
  if (!payload) return null;
  const mime = payload.mimeType ?? '';
  if ((mime === 'text/html' || mime === 'text/plain') && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  // Prefer text/html part when multipart
  const parts = payload.parts ?? [];
  const htmlPart = parts.find((p) => p.mimeType === 'text/html');
  if (htmlPart) { const r = extractBody(htmlPart); if (r) return r; }
  for (const part of parts) {
    const result = extractBody(part);
    if (result) return result;
  }
  return null;
}

/**
 * Fetch the body of a single message for unsubscribe link scanning.
 * Body is used transiently — never stored. Returns string or null.
 */
export async function fetchBodyForUnsubscribe(auth, messageId) {
  const gmail = google.gmail({ version: 'v1', auth });
  try {
    const res = await gmail.users.messages.get({
      userId: 'me', id: messageId, format: 'full', fields: 'payload',
    });
    return extractBody(res.data.payload);
  } catch {
    return null;
  }
}

/** Fetch List-Unsubscribe header from a single message. */
export async function fetchListUnsubscribe(auth, messageId) {
  const gmail = google.gmail({ version: 'v1', auth });
  try {
    const res = await gmail.users.messages.get({
      userId: 'me', id: messageId, format: 'metadata',
      metadataHeaders: ['List-Unsubscribe', 'List-Unsubscribe-Post'],
      fields: 'payload/headers',
    });
    const headers = res.data.payload?.headers ?? [];
    const headerValue = headers.find((h) => h.name === 'List-Unsubscribe')?.value ?? null;
    const postHeader = headers.find((h) => h.name === 'List-Unsubscribe-Post')?.value ?? null;
    return { headerValue, hasOneClick: postHeader?.toLowerCase().includes('one-click') ?? false };
  } catch {
    return { headerValue: null, hasOneClick: false };
  }
}
