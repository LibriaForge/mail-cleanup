import 'dotenv/config';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { createInterface } from 'readline';
import { loadCheckpoint, clearCheckpoint } from './checkpoint.js';
import { manageWhitelist } from './whitelist.js';

// Lazily imported based on user choice
let gmailAuth, gmailProvider, outlookAuth, outlookProvider;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '../.env');

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI flags from process.argv.
 * Supported flags:
 *   --dry-run            never call deleteEmails/archiveEmails
 *   --auto               skip all interactive prompts
 *   --since=YYYY-MM-DD   only process emails on or before this date
 *   --whitelist          open the whitelist manager
 *
 * @returns {{ dryRun: boolean, auto: boolean, since: string|null, whitelist: boolean }}
 */
function parseFlags() {
  const args = process.argv.slice(2);
  const flags = { dryRun: false, auto: false, since: null, whitelist: false };

  for (const arg of args) {
    if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--auto') {
      flags.auto = true;
    } else if (arg === '--whitelist') {
      flags.whitelist = true;
    } else if (arg.startsWith('--since=')) {
      const dateStr = arg.slice('--since='.length).trim();
      // Basic ISO date validation: YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        flags.since = dateStr;
      } else {
        console.log(chalk.yellow(`Warning: --since value "${dateStr}" is not a valid YYYY-MM-DD date. Ignoring.`));
      }
    }
  }

  return flags;
}

/**
 * Validate that required environment variables exist for the chosen provider.
 */
function checkEnv(provider) {
  const missing = [];

  if (provider === 'gmail') {
    if (!process.env.GMAIL_CLIENT_ID) missing.push('GMAIL_CLIENT_ID');
    if (!process.env.GMAIL_CLIENT_SECRET) missing.push('GMAIL_CLIENT_SECRET');
  } else if (provider === 'outlook') {
    if (!process.env.OUTLOOK_CLIENT_ID) missing.push('OUTLOOK_CLIENT_ID');
  }

  if (missing.length > 0) {
    console.log('');
    console.log(chalk.red.bold('Missing required environment variables:'));
    for (const key of missing) {
      console.log(chalk.red(`  • ${key}`));
    }
    console.log('');
    console.log(chalk.yellow('Create a .env file in the project root.'));
    console.log(chalk.yellow('See .env.example for setup instructions.'));
    process.exit(1);
  }
}

/**
 * Print a welcome banner, optionally preceded by mode indicators.
 */
function printBanner(flags) {
  if (flags.dryRun) {
    console.log(chalk.yellow('[DRY RUN]'));
  }
  if (flags.auto) {
    console.log(chalk.yellow('[AUTO MODE]'));
  }

  console.log('');
  console.log(chalk.bgCyan.black.bold('  MAIL CLEANUP  '));
  console.log(chalk.cyan('  Triage your emails, sender by sender.'));
  console.log('');
  console.log(chalk.bold('  Flags:'));
  console.log(`  ${chalk.cyan('--dry-run')}          Preview actions without deleting or archiving anything`);
  console.log(`  ${chalk.cyan('--auto')}              Apply all decisions automatically, no prompts`);
  console.log(`  ${chalk.cyan('--since=YYYY-MM-DD')}  Only process emails received on or before this date`);
  console.log(`  ${chalk.cyan('--whitelist')}         Manage the sender whitelist (always kept)`);
  console.log(`  ${chalk.cyan('DEBUG=1')}             Show full error stack traces`);
  console.log('');

  if (!existsSync(ENV_PATH)) {
    console.log(
      chalk.yellow(
        'Tip: No .env file found. Copy .env.example to .env and fill in your credentials.\n'
      )
    );
  }
}

/**
 * Ask the user which email provider to use.
 */
async function pickProvider() {
  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Which email account do you want to clean up?',
      choices: [
        { name: `${chalk.red('Gmail')}   — uses OAuth2 (opens browser)`, value: 'gmail' },
        { name: `${chalk.blue('Outlook')} — uses device code flow (no browser redirect needed)`, value: 'outlook' },
        new inquirer.Separator(),
        { name: chalk.gray('Exit'), value: 'exit' },
      ],
    },
  ]);
  return provider;
}

/**
 * Ask the user whether to resume a checkpoint session.
 * Returns true for Y, false for N.
 *
 * @param {string} providerName
 * @param {string} createdAt - ISO timestamp of when the checkpoint was created
 * @returns {Promise<boolean>}
 */
async function askResumeCheckpoint(providerName, createdAt) {
  const dateStr = new Date(createdAt).toLocaleString();
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      chalk.yellow(`\nA previous ${providerName} session checkpoint exists (started ${dateStr}).\nResume from where you left off? [Y/N]: `),
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      }
    );
  });
}

async function runGmail(flags) {
  checkEnv('gmail');

  gmailAuth = await import('./auth/gmail-auth.js');
  gmailProvider = await import('./providers/gmail.js');

  const auth = await gmailAuth.authenticateGmail();

  // Checkpoint handling
  let checkpoint = null;
  let excludeIds = [];
  const existingCheckpoint = loadCheckpoint();

  if (existingCheckpoint && existingCheckpoint.provider === 'gmail') {
    const resume = await askResumeCheckpoint('Gmail', existingCheckpoint.createdAt);
    if (resume) {
      checkpoint = existingCheckpoint;
      excludeIds = existingCheckpoint.processedEmails ?? [];
      console.log(chalk.cyan(`Resuming — skipping ${excludeIds.length.toLocaleString()} already-processed email(s).`));
    } else {
      clearCheckpoint();
    }
  }

  const groups = await gmailProvider.fetchAndGroupEmails(auth, { since: flags.since, excludeIds });

  const { runReviewLoop } = await import('./ui/menu.js');
  await runReviewLoop(groups, gmailProvider, auth, flags, checkpoint, 'gmail');
}

async function runOutlook(flags) {
  checkEnv('outlook');

  outlookAuth = await import('./auth/outlook-auth.js');
  outlookProvider = await import('./providers/outlook.js');

  const accessToken = await outlookAuth.authenticateOutlook();

  // Checkpoint handling
  let checkpoint = null;
  let excludeIds = [];
  const existingCheckpoint = loadCheckpoint();

  if (existingCheckpoint && existingCheckpoint.provider === 'outlook') {
    const resume = await askResumeCheckpoint('Outlook', existingCheckpoint.createdAt);
    if (resume) {
      checkpoint = existingCheckpoint;
      excludeIds = existingCheckpoint.processedEmails ?? [];
      console.log(chalk.cyan(`Resuming — skipping ${excludeIds.length.toLocaleString()} already-processed email(s).`));
    } else {
      clearCheckpoint();
    }
  }

  const groups = await outlookProvider.fetchAndGroupEmails(accessToken, { since: flags.since, excludeIds });

  const { runReviewLoop } = await import('./ui/menu.js');
  await runReviewLoop(groups, outlookProvider, accessToken, flags, checkpoint, 'outlook');
}

async function main() {
  const flags = parseFlags();

  // --whitelist: open the whitelist manager and exit
  if (flags.whitelist) {
    await manageWhitelist();
    process.exit(0);
  }

  printBanner(flags);

  const provider = await pickProvider();

  if (provider === 'exit') {
    console.log(chalk.gray('\nGoodbye.\n'));
    process.exit(0);
  }

  try {
    if (provider === 'gmail') {
      await runGmail(flags);
    } else if (provider === 'outlook') {
      await runOutlook(flags);
    }
  } catch (err) {
    console.log('');
    console.log(chalk.red.bold('An error occurred:'));
    console.log(chalk.red(err.message));

    if (process.env.DEBUG) {
      console.log('');
      console.log(chalk.gray(err.stack));
    } else {
      console.log(chalk.gray('  Set DEBUG=1 in .env or environment to see the full stack trace.'));
    }

    process.exit(1);
  }
}

main();
