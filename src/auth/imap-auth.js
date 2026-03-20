import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { ImapFlow } from 'imapflow';

const CONFIG_PATH = join(process.cwd(), 'imap-config.json');

const PRESETS = {
  yahoo:  { label: 'Yahoo Mail',   host: 'imap.mail.yahoo.com',  port: 993, secure: true },
  aol:    { label: 'AOL Mail',     host: 'imap.aol.com',          port: 993, secure: true },
  icloud: { label: 'Apple iCloud', host: 'imap.mail.me.com',      port: 993, secure: true },
  zoho:   { label: 'Zoho Mail',    host: 'imap.zoho.com',         port: 993, secure: true },
  custom: { label: 'Custom…',      host: null, port: 993, secure: true },
};

async function promptConfig() {
  const { preset } = await inquirer.prompt([{
    type: 'list', name: 'preset',
    message: 'Which email provider?',
    choices: Object.entries(PRESETS).map(([value, { label }]) => ({ name: label, value })),
  }]);

  let host = PRESETS[preset].host;
  let port = PRESETS[preset].port;
  let secure = PRESETS[preset].secure;

  if (preset === 'custom') {
    const answers = await inquirer.prompt([
      { type: 'input',   name: 'host',   message: 'IMAP host:',    validate: (v) => v.trim() !== '' || 'Required' },
      { type: 'number',  name: 'port',   message: 'IMAP port:',    default: 993 },
      { type: 'confirm', name: 'secure', message: 'Use TLS/SSL?',  default: true },
    ]);
    host = answers.host.trim();
    port = answers.port;
    secure = answers.secure;
  }

  const credentials = await inquirer.prompt([
    { type: 'input',    name: 'user', message: 'Email address:', validate: (v) => v.trim() !== '' || 'Required' },
    { type: 'password', name: 'pass', message: 'Password / App password:', mask: '*', validate: (v) => v !== '' || 'Required' },
  ]);

  if (preset === 'yahoo' || preset === 'aol') {
    console.log(chalk.yellow('\n  Tip: Yahoo and AOL require an App Password — your regular password will not work.'));
    console.log(chalk.yellow('  Generate one at: https://login.yahoo.com/account/security (Yahoo) or https://myaccount.aol.com (AOL)\n'));
  }

  return { host, port, secure, user: credentials.user.trim(), pass: credentials.pass };
}

/**
 * Load or prompt IMAP config and return a connected ImapFlow client.
 * The caller is responsible for calling client.logout() when done.
 */
export async function getImapClient() {
  let config;

  if (existsSync(CONFIG_PATH)) {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    console.log(chalk.gray(`  Using saved IMAP config for ${config.user} on ${config.host}`));
  } else {
    console.log(chalk.bold('\n  IMAP Setup'));
    config = await promptConfig();
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(chalk.green('  Config saved to imap-config.json'));
    console.log(chalk.yellow('  ⚠ Warning: your password is stored in plain text in imap-config.json.'));
    console.log(chalk.yellow('  Keep this file private and do not share or commit it.\n'));
  }

  const clientOptions = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  };

  let client = new ImapFlow(clientOptions);

  try {
    await client.connect();
  } catch (err) {
    if (err.message?.includes('certificate') || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
      console.log(chalk.yellow('\n  TLS certificate error — your network or antivirus may be intercepting the connection.'));
      console.log(chalk.yellow('  Retrying with certificate verification disabled (connection is still encrypted).\n'));
      await client.logout().catch(() => {});
      client = new ImapFlow({ ...clientOptions, tls: { rejectUnauthorized: false } });
      await client.connect();
    } else {
      throw err;
    }
  }

  return client;
}
