import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import inquirer from 'inquirer';
import chalk from 'chalk';

const WHITELIST_PATH = join(process.cwd(), 'whitelist.json');

/**
 * Load the whitelist from whitelist.json.
 * Returns an empty array if the file does not exist or is malformed.
 *
 * @returns {string[]}
 */
export function loadWhitelist() {
  if (!existsSync(WHITELIST_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(WHITELIST_PATH, 'utf8'));
    if (Array.isArray(data)) return data.map((e) => String(e).toLowerCase().trim());
    return [];
  } catch {
    return [];
  }
}

/**
 * Write the whitelist array to whitelist.json.
 *
 * @param {string[]} list
 */
export function saveWhitelist(list) {
  writeFileSync(WHITELIST_PATH, JSON.stringify(list, null, 2));
}

/**
 * Interactive CLI manager for the whitelist.
 * Presents a menu: list / add / remove / exit.
 */
export async function manageWhitelist() {
  console.log('');
  console.log(chalk.bold.cyan('Whitelist Manager'));
  console.log(chalk.gray('Senders on this list are silently kept during review.\n'));

  let running = true;

  while (running) {
    const list = loadWhitelist();

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Whitelist — what would you like to do?',
        choices: [
          { name: 'List current entries', value: 'list' },
          { name: 'Add an email address', value: 'add' },
          { name: 'Remove an entry', value: 'remove' },
          new inquirer.Separator(),
          { name: chalk.gray('Exit whitelist manager'), value: 'exit' },
        ],
      },
    ]);

    if (action === 'list') {
      if (list.length === 0) {
        console.log(chalk.gray('\n  (whitelist is empty)\n'));
      } else {
        console.log('');
        list.forEach((entry, i) => {
          console.log(`  ${chalk.gray(String(i + 1) + '.')} ${entry}`);
        });
        console.log('');
      }

    } else if (action === 'add') {
      const email = await new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question('  Email address to add: ', (answer) => {
          rl.close();
          resolve(answer.trim().toLowerCase());
        });
      });

      if (!email) {
        console.log(chalk.yellow('  No address entered — skipping.\n'));
      } else if (list.includes(email)) {
        console.log(chalk.yellow(`  ${email} is already on the whitelist.\n`));
      } else {
        list.push(email);
        saveWhitelist(list);
        console.log(chalk.green(`  Added ${email} to the whitelist.\n`));
      }

    } else if (action === 'remove') {
      if (list.length === 0) {
        console.log(chalk.gray('\n  (whitelist is empty — nothing to remove)\n'));
      } else {
        const { toRemove } = await inquirer.prompt([
          {
            type: 'list',
            name: 'toRemove',
            message: 'Select an entry to remove:',
            choices: [
              ...list.map((e) => ({ name: e, value: e })),
              new inquirer.Separator(),
              { name: chalk.gray('Cancel'), value: null },
            ],
          },
        ]);

        if (toRemove) {
          const updated = list.filter((e) => e !== toRemove);
          saveWhitelist(updated);
          console.log(chalk.green(`  Removed ${toRemove} from the whitelist.\n`));
        } else {
          console.log(chalk.gray('  Cancelled.\n'));
        }
      }

    } else {
      running = false;
    }
  }

  console.log(chalk.gray('Exiting whitelist manager.\n'));
}
