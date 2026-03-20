import ora from 'ora';
import chalk from 'chalk';

// Maximum subjects to keep per sender for display
const MAX_SUBJECTS = 5;

/**
 * Common JUNK/SPAM folder names to try, in order of preference.
 */
const JUNK_FOLDER_NAMES = ['Junk', 'Spam', 'Bulk Mail', 'Junk Email', 'JUNK', 'SPAM'];

/**
 * Common ARCHIVE folder names to try, in order of preference.
 */
const ARCHIVE_FOLDER_NAMES = ['Archive', 'Archives', 'ARCHIVE'];

/**
 * List all mailbox names on the server.
 * @param {ImapFlow} client
 * @returns {Promise<string[]>}
 */
async function listFolders(client) {
  const list = await client.list();
  return list.map((m) => m.path);
}

/**
 * Find the first existing folder from a list of candidates.
 * @param {ImapFlow} client
 * @param {string[]} candidates
 * @returns {Promise<string|null>}
 */
async function findFolder(client, candidates) {
  const folders = await listFolders(client);
  const folderSet = new Set(folders.map((f) => f.toLowerCase()));
  for (const name of candidates) {
    if (folderSet.has(name.toLowerCase())) return name;
  }
  return null;
}

/**
 * Get or create a folder by name. Returns the folder path.
 * @param {ImapFlow} client
 * @param {string} name
 * @returns {Promise<string>}
 */
async function getOrCreateFolder(client, name) {
  const folders = await listFolders(client);
  const existing = folders.find((f) => f.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  await client.mailboxCreate(name);
  return name;
}

/**
 * Build an IMAP SEARCH criteria object from options.
 */
function buildSearchCriteria(unreadOnly, from, to) {
  const criteria = {};
  if (unreadOnly) criteria.unseen = true;
  if (from) criteria.since = new Date(from);
  if (to) {
    // Make `to` inclusive: search before the day after
    const d = new Date(to);
    d.setDate(d.getDate() + 1);
    criteria.before = d;
  }
  return criteria;
}

/**
 * Fetch all emails and group them by sender.
 * Returns an array of { email, name, count, subjects, ids } sorted by count desc.
 *
 * @param {ImapFlow} client - connected ImapFlow client
 * @param {object} [options]
 * @param {string} [options.from]       - ISO date string (YYYY-MM-DD)
 * @param {string} [options.to]         - ISO date string (YYYY-MM-DD)
 * @param {boolean} [options.inbox]     - if true, only fetch emails from INBOX
 * @param {boolean} [options.unreadOnly] - if true, only fetch unseen emails
 * @param {string[]} [options.excludeIds] - UIDs to exclude (checkpoint resume)
 */
export async function fetchAndGroupEmails(client, options = {}) {
  const { from, to, inbox = true, unreadOnly = true, excludeIds = [] } = options;

  const spinner = ora({ text: chalk.cyan('Connecting to mailbox…'), color: 'cyan' }).start();

  try {
    const mailbox = inbox ? 'INBOX' : null;

    // If scanning all folders, collect from each one
    let allMessages = [];

    if (inbox) {
      await client.mailboxOpen('INBOX');
      const messages = await fetchFromOpenMailbox(client, unreadOnly, from, to, spinner, 'INBOX');
      allMessages = messages;
    } else {
      const folders = await listFolders(client);
      // Exclude well-known junk/trash folders when scanning all
      const skipPatterns = /\b(trash|deleted|junk|spam|bulk|drafts|sent|outbox)\b/i;
      const foldersToScan = folders.filter((f) => !skipPatterns.test(f));

      for (const folder of foldersToScan) {
        spinner.text = chalk.cyan(`Scanning folder: ${folder}…`);
        try {
          await client.mailboxOpen(folder);
          const msgs = await fetchFromOpenMailbox(client, unreadOnly, from, to, spinner, folder);
          allMessages.push(...msgs);
        } catch {
          // Some folders may not be selectable — skip silently
        }
      }
    }

    // Filter checkpoint exclusions
    const excludeSet = new Set(excludeIds.map(String));
    const messages = excludeIds.length > 0
      ? allMessages.filter((m) => !excludeSet.has(String(m.uid)))
      : allMessages;

    if (messages.length === 0) {
      spinner.succeed(chalk.green('No emails found matching the criteria.'));
      return [];
    }

    spinner.text = chalk.cyan(`Grouping ${messages.length.toLocaleString()} messages by sender…`);

    const senderMap = new Map();
    for (const msg of messages) {
      const from = msg.envelope?.from?.[0];
      const email = (from?.address ?? 'unknown').toLowerCase().trim();
      const name = from?.name || from?.address || email;
      const subject = msg.envelope?.subject ?? '(no subject)';
      const msgDate = msg.envelope?.date ? new Date(msg.envelope.date) : null;

      if (!senderMap.has(email)) {
        senderMap.set(email, { name, subjects: [], ids: [], newestDate: null });
      }
      const entry = senderMap.get(email);
      if (entry.subjects.length < MAX_SUBJECTS) entry.subjects.push(subject);
      entry.ids.push(String(msg.uid));
      if (msgDate && !isNaN(msgDate) && (!entry.newestDate || msgDate > entry.newestDate)) {
        entry.newestDate = msgDate;
      }
    }

    spinner.succeed(
      chalk.green(
        `Loaded ${messages.length.toLocaleString()} emails from ${senderMap.size.toLocaleString()} senders.`
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
        newestDate: data.newestDate ? data.newestDate.toISOString().slice(0, 10) : null,
      });
    }
    groups.sort((a, b) => b.count - a.count);
    return groups;
  } catch (err) {
    spinner.fail(chalk.red('Failed to fetch messages.'));
    throw err;
  }
}

/**
 * Fetch envelope data for all matching messages in the currently open mailbox.
 * Returns array of { uid, envelope }.
 */
async function fetchFromOpenMailbox(client, unreadOnly, from, to, spinner, folderName) {
  const criteria = buildSearchCriteria(unreadOnly, from, to);
  const uids = await client.search(criteria, { uid: true });

  if (!uids || uids.length === 0) return [];

  spinner.text = chalk.cyan(`Fetching envelopes from ${folderName} (${uids.length.toLocaleString()} messages)…`);

  const messages = [];
  for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
    messages.push({ uid: msg.uid, envelope: msg.envelope });
  }
  return messages;
}

/**
 * Permanently delete messages by UID.
 * @param {ImapFlow} client
 * @param {string[]} ids - UIDs as strings
 */
export async function deleteEmails(client, ids) {
  if (ids.length === 0) return;
  // INBOX must be open; we open it here in case the caller hasn't
  await client.mailboxOpen('INBOX');
  await client.messageDelete(ids.map(Number), { uid: true });
}

/**
 * Archive messages by moving them to the Archive folder (creates it if needed).
 * @param {ImapFlow} client
 * @param {string[]} ids
 */
export async function archiveEmails(client, ids) {
  if (ids.length === 0) return;
  await client.mailboxOpen('INBOX');
  let archiveFolder = await findFolder(client, ARCHIVE_FOLDER_NAMES);
  if (!archiveFolder) {
    archiveFolder = await getOrCreateFolder(client, 'Archive');
  }
  await client.messageMove(ids.map(Number), archiveFolder, { uid: true });
}

/**
 * Move messages to a named folder (creates it if it doesn't exist).
 * @param {ImapFlow} client
 * @param {string[]} ids
 * @param {string} folderName
 */
export async function moveToFolder(client, ids, folderName) {
  if (ids.length === 0) return;
  await client.mailboxOpen('INBOX');
  const folder = await getOrCreateFolder(client, folderName);
  await client.messageMove(ids.map(Number), folder, { uid: true });
}

/**
 * Move messages to the Junk/Spam folder.
 * @param {ImapFlow} client
 * @param {string[]} ids
 */
export async function markAsSpam(client, ids) {
  if (ids.length === 0) return;
  await client.mailboxOpen('INBOX');
  let junkFolder = await findFolder(client, JUNK_FOLDER_NAMES);
  if (!junkFolder) {
    junkFolder = await getOrCreateFolder(client, 'Junk');
  }
  await client.messageMove(ids.map(Number), junkFolder, { uid: true });
}

/**
 * Fetch the List-Unsubscribe header from a message.
 * @param {ImapFlow} client
 * @param {string} messageId - UID as string
 * @returns {Promise<{ headerValue: string|null, hasOneClick: boolean }>}
 */
export async function fetchListUnsubscribe(client, messageId) {
  try {
    await client.mailboxOpen('INBOX');
    let headerValue = null;
    let hasOneClick = false;
    for await (const msg of client.fetch([Number(messageId)], { headers: ['list-unsubscribe', 'list-unsubscribe-post'] }, { uid: true })) {
      const headers = msg.headers;
      if (headers) {
        // imapflow returns a Buffer; parse it as text
        const raw = headers.toString('utf-8');
        const unsubMatch = raw.match(/^list-unsubscribe:\s*(.+)$/im);
        const postMatch = raw.match(/^list-unsubscribe-post:\s*(.+)$/im);
        headerValue = unsubMatch ? unsubMatch[1].trim() : null;
        hasOneClick = postMatch ? postMatch[1].toLowerCase().includes('one-click') : false;
      }
    }
    return { headerValue, hasOneClick };
  } catch {
    return { headerValue: null, hasOneClick: false };
  }
}

/**
 * Fetch the body of a message for unsubscribe link scanning.
 * Returns the raw body as a string, or null on failure.
 * @param {ImapFlow} client
 * @param {string} messageId - UID as string
 * @returns {Promise<string|null>}
 */
export async function fetchBodyForUnsubscribe(client, messageId) {
  try {
    await client.mailboxOpen('INBOX');
    for await (const msg of client.fetch([Number(messageId)], { source: true }, { uid: true })) {
      if (msg.source) return msg.source.toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}
