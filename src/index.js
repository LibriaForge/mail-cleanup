import 'dotenv/config';
import { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, OUTLOOK_CLIENT_ID } from './credentials.js';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { loadCheckpoint, clearCheckpoint } from './checkpoint.js';
import { manageWhitelist } from './whitelist.js';
import * as gmailAuth from './auth/gmail-auth.js';
import * as gmailProvider from './providers/gmail.js';
import * as outlookAuth from './auth/outlook-auth.js';
import * as outlookProvider from './providers/outlook.js';
import { runReviewLoop } from './ui/menu.js';

const ENV_PATH = join(process.cwd(), '.env');

// Read version from package.json (works both in dev and compiled binary)
let VERSION = 'unknown';
try {
  const pkgPath = new URL('../package.json', import.meta.url);
  VERSION = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} catch { /* compiled binary — version baked in below */ }
// Bun bakes import.meta.url differently; fall back to the injected constant
if (VERSION === 'unknown') VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI flags from process.argv.
 * Supported flags:
 *   --dry-run            never call deleteEmails/archiveEmails
 *   --auto               skip all interactive prompts
 *   --from=YYYY-MM-DD    only process emails received on or after this date
 *   --to=YYYY-MM-DD      only process emails received on or before this date
 *   --whitelist          open the whitelist manager
 *
 * @returns {{ dryRun: boolean, auto: boolean, from: string|null, to: string|null, whitelist: boolean, report: boolean }}
 */
function parseFlags() {
  const args = process.argv.slice(2);
  const flags = { dryRun: false, auto: false, from: null, to: null, whitelist: false, report: false };

  const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  for (const arg of args) {
    if (arg === '--version' || arg === '-v') {
      console.log(`mail-cleanup v${VERSION}`);
      process.exit(0);
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--auto') {
      flags.auto = true;
    } else if (arg === '--whitelist') {
      flags.whitelist = true;
    } else if (arg === '--report') {
      flags.report = true;
    } else if (arg.startsWith('--from=')) {
      const dateStr = arg.slice('--from='.length).trim();
      if (isValidDate(dateStr)) flags.from = dateStr;
      else console.log(chalk.yellow(`Warning: --from value "${dateStr}" is not a valid YYYY-MM-DD date. Ignoring.`));
    } else if (arg.startsWith('--to=')) {
      const dateStr = arg.slice('--to='.length).trim();
      if (isValidDate(dateStr)) flags.to = dateStr;
      else console.log(chalk.yellow(`Warning: --to value "${dateStr}" is not a valid YYYY-MM-DD date. Ignoring.`));
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
    if (!GMAIL_CLIENT_ID && !process.env.GMAIL_CLIENT_ID) missing.push('GMAIL_CLIENT_ID');
    if (!GMAIL_CLIENT_SECRET && !process.env.GMAIL_CLIENT_SECRET) missing.push('GMAIL_CLIENT_SECRET');
  } else if (provider === 'outlook') {
    if (!OUTLOOK_CLIENT_ID && !process.env.OUTLOOK_CLIENT_ID) missing.push('OUTLOOK_CLIENT_ID');
  }

  if (missing.length > 0) {
    console.log('');
    console.log(chalk.red.bold('Missing app credentials:'));
    for (const key of missing) {
      console.log(chalk.red(`  • ${key}`));
    }
    console.log('');
    console.log(chalk.yellow('This binary was not built with app credentials baked in.'));
    console.log(chalk.yellow('Set the missing variables in a .env file next to the executable.'));
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
  console.log(chalk.bgCyan.black.bold('  MAIL CLEANUP  ') + chalk.gray(` v${VERSION}`));
  console.log(chalk.cyan('  Triage your emails, sender by sender.'));
  console.log('');
  console.log(chalk.bold('  Flags:'));
  console.log(`  ${chalk.cyan('--dry-run')}          Preview actions without deleting or archiving anything`);
  console.log(`  ${chalk.cyan('--auto')}              Apply all decisions automatically, no prompts`);
  console.log(`  ${chalk.cyan('--from=YYYY-MM-DD')}   Only process emails received on or after this date`);
  console.log(`  ${chalk.cyan('--to=YYYY-MM-DD')}     Only process emails received on or before this date`);
  console.log(`  ${chalk.cyan('--whitelist')}         Manage the sender whitelist (always kept)`);
  console.log(`  ${chalk.cyan('--report')}            Write a JSON summary to reports/YYYY-MM-DD-HH-MM.json`);
  console.log(`  ${chalk.cyan('DEBUG=1')}             Show full error stack traces`);
  console.log('');

  if (!existsSync(ENV_PATH) && process.env.ANTHROPIC_API_KEY === undefined) {
    console.log(chalk.gray('  Tip: Add ANTHROPIC_API_KEY=... to a .env file next to the executable to enable AI classification.\n'));
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

  const groups = await gmailProvider.fetchAndGroupEmails(auth, { from: flags.from, to: flags.to, excludeIds });
  await runReviewLoop(groups, gmailProvider, auth, flags, checkpoint, 'gmail');
}

async function runOutlook(flags) {
  checkEnv('outlook');

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

  const groups = await outlookProvider.fetchAndGroupEmails(accessToken, { from: flags.from, to: flags.to, excludeIds });
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
