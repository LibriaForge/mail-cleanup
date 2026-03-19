import { google } from 'googleapis';
import ora from 'ora';
import chalk from 'chalk';

// How many message IDs to fetch per page
const PAGE_SIZE = 500;
// How many message metadata requests to run in parallel
const METADATA_BATCH_SIZE = 50;

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
 * @param {string|undefined} since - optional ISO date string (YYYY-MM-DD); if set, only fetch emails
 *   received before (and on) this date using Gmail's `before:` operator.
 */
async function fetchAllMessageIds(gmail, spinner, since) {
  const ids = [];
  let pageToken;
  let page = 0;

  // Build the query string
  let query = 'in:all -in:trash';
  if (since) {
    // Gmail's before: operator uses YYYY/MM/DD format and is exclusive of the given date,
    // so we add one day to make the filter inclusive of the requested date.
    const d = new Date(since);
    d.setDate(d.getDate() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    const beforeStr = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    query += ` before:${beforeStr}`;
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
 * @param {string} [options.since] - ISO date string (YYYY-MM-DD); only include emails on or before this date
 * @param {string[]} [options.excludeIds] - message IDs to exclude (already processed in a previous session)
 */
export async function fetchAndGroupEmails(auth, options = {}) {
  const { since, excludeIds = [] } = options;
  const gmail = google.gmail({ version: 'v1', auth });
  const spinner = ora({ text: chalk.cyan('Connecting to Gmail…'), color: 'cyan' }).start();

  try {
    // Step 1: Get all message IDs
    const allIds = await fetchAllMessageIds(gmail, spinner, since);

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
    await gmail.users.messages.batchDelete({
      userId: 'me',
      requestBody: { ids: chunk },
    });
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
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: chunk,
        removeLabelIds: ['INBOX', 'UNREAD'],
      },
    });
  }
}
