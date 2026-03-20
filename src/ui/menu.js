import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import Anthropic from '@anthropic-ai/sdk';
import { createInterface } from 'readline';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { classifyByKeywords, classifyWithClaude, CATEGORY_FOLDERS } from '../ai/classifier.js';
import { loadWhitelist } from '../whitelist.js';
import { saveCheckpoint, clearCheckpoint } from '../checkpoint.js';
import { loadRules, saveRules, getRuleForSender } from '../rules.js';
import { parseUnsubscribeHeader, executeUnsubscribe } from '../unsubscribe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '../../reports');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n) { return n.toLocaleString(); }

function askYN(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

function renderSenderCard(group, index, total) {
  const { email, name, count, subjects } = group;
  const displayName = name !== email ? chalk.bold(name) + chalk.gray(` <${email}>`) : chalk.bold(email);
  console.log('');
  console.log(chalk.bgBlue.white.bold(` Sender ${index + 1} of ${total} `));
  console.log(`  From  : ${displayName}`);
  console.log(`  Emails: ${chalk.yellow(fmt(count))}`);
  console.log(`  Subjects:`);
  for (const subject of subjects.slice(0, 3)) console.log(`    ${chalk.gray('•')} ${subject}`);
  if (subjects.length > 3) console.log(chalk.gray(`    … and more`));
}

/**
 * Prompt the user for an action.
 * canUnsubscribe: show "Unsubscribe + Delete" option.
 * suggestedFolder: if set, label the archive option with the folder name.
 */
async function promptAction(group, { canUnsubscribe = false, suggestedFolder = null } = {}) {
  const archiveLabel = suggestedFolder
    ? `Move to ${suggestedFolder}  — archive into the ${suggestedFolder} folder`
    : `Archive All  — move out of inbox, mark as read`;

  const choices = [
    { name: `Delete All   — permanently remove all ${fmt(group.count)} emails`, value: 'delete' },
  ];
  if (canUnsubscribe) {
    choices.push({ name: `Unsubscribe + Delete — unsubscribe then delete all`, value: 'unsubscribe_delete' });
  }
  choices.push(
    { name: archiveLabel, value: 'archive' },
    { name: `Keep         — leave emails as they are`, value: 'keep' },
    { name: `Skip         — decide later`, value: 'skip' },
    new inquirer.Separator(),
    { name: `Quit         — stop and show summary`, value: 'quit' },
  );

  const { action } = await inquirer.prompt([{
    type: 'list', name: 'action',
    message: `What to do with ${chalk.yellow(fmt(group.count))} email(s) from this sender?`,
    choices, pageSize: 8,
  }]);
  return action;
}

/**
 * Execute the chosen action. folder overrides default archive destination.
 */
async function executeAction(action, group, provider, authToken, dryRun = false, folder = null) {
  if (action === 'keep' || action === 'skip') return;

  if (dryRun) {
    const dest = folder ? ` → ${folder}` : '';
    console.log(chalk.yellow(`  [DRY RUN] Would ${action} ${fmt(group.count)} email(s) from ${group.email}${dest}`));
    return;
  }

  const verb = action === 'delete' ? 'Deleting' : folder ? `Moving to ${folder}` : 'Archiving';
  const spinner = ora({ text: chalk.cyan(`${verb} ${fmt(group.count)} email(s)…`), color: 'cyan' }).start();

  try {
    if (action === 'delete') {
      await provider.deleteEmails(authToken, group.ids);
      spinner.succeed(chalk.red(`Deleted ${fmt(group.count)} email(s) from ${group.email}.`));
    } else if (action === 'archive') {
      if (folder && provider.moveToFolder) {
        await provider.moveToFolder(authToken, group.ids, folder);
        spinner.succeed(chalk.blue(`Moved ${fmt(group.count)} email(s) from ${group.email} → ${folder}.`));
      } else {
        await provider.archiveEmails(authToken, group.ids);
        spinner.succeed(chalk.blue(`Archived ${fmt(group.count)} email(s) from ${group.email}.`));
      }
    }
  } catch (err) {
    spinner.fail(chalk.red(`Failed to ${action} emails from ${group.email}: ${err.message}`));
    throw err;
  }
}

function printSummary(stats) {
  const { deleted, archived, kept, skipped, total } = stats;
  console.log('');
  console.log(chalk.bold.white('━'.repeat(52)));
  console.log(chalk.bold.white('  SESSION SUMMARY'));
  console.log(chalk.bold.white('━'.repeat(52)));
  console.log(`  ${chalk.red('Deleted')}  : ${fmt(deleted.emails)} email(s) from ${fmt(deleted.senders)} sender(s)`);
  console.log(`  ${chalk.blue('Archived')} : ${fmt(archived.emails)} email(s) from ${fmt(archived.senders)} sender(s)`);
  console.log(`  ${chalk.green('Kept')}     : ${fmt(kept.emails)} email(s) from ${fmt(kept.senders)} sender(s)`);
  console.log(`  ${chalk.gray('Skipped')}  : ${fmt(skipped.emails)} email(s) from ${fmt(skipped.senders)} sender(s)`);
  console.log(chalk.bold.white('━'.repeat(52)));
  console.log(`  Total reviewed: ${fmt(total.senders)} sender group(s) / ${fmt(total.emails)} email(s)`);
  console.log('');
}

function recordStat(stats, action, group) {
  const key = action === 'delete' ? 'deleted' : action === 'archive' ? 'archived' : action === 'keep' ? 'kept' : 'skipped';
  stats[key].senders++;
  stats[key].emails += group.count;
  stats.total.senders++;
  stats.total.emails += group.count;
}

function saveReport(providerName, stats, actions) {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const filename = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.json`;
  const report = { date: now.toISOString(), provider: providerName, stats, actions };
  writeFileSync(join(REPORTS_DIR, filename), JSON.stringify(report, null, 2));
  console.log(chalk.gray(`  Report saved to reports/${filename}`));
}

// ---------------------------------------------------------------------------
// Main review loop
// ---------------------------------------------------------------------------

export async function runReviewLoop(groups, provider, authToken, flags = {}, checkpoint = null, providerName = '') {
  const { dryRun = false, auto = false, report = false } = flags;

  if (groups.length === 0) {
    console.log(chalk.green('\nNo sender groups to review. Your inbox is clean!'));
    clearCheckpoint();
    return;
  }

  // Whitelist filtering
  const whitelist = loadWhitelist();
  const whitelistSet = new Set(whitelist.map((e) => e.toLowerCase().trim()));

  const rules = loadRules();

  const stats = checkpoint?.stats ?? {
    deleted:  { senders: 0, emails: 0 },
    archived: { senders: 0, emails: 0 },
    kept:     { senders: 0, emails: 0 },
    skipped:  { senders: 0, emails: 0 },
    total:    { senders: 0, emails: 0 },
  };

  const processedEmails = checkpoint?.processedEmails ? [...checkpoint.processedEmails] : [];
  const reportActions = [];

  const persistCheckpoint = () => {
    if (!providerName) return;
    saveCheckpoint({ provider: providerName, createdAt: checkpoint?.createdAt ?? new Date().toISOString(), processedEmails, stats });
  };

  // Whitelist pass
  const activeGroups = [];
  let whitelistedCount = 0;
  for (const group of groups) {
    if (whitelistSet.has(group.email.toLowerCase().trim())) {
      recordStat(stats, 'keep', group);
      processedEmails.push(...group.ids);
      whitelistedCount++;
    } else {
      activeGroups.push(group);
    }
  }
  if (whitelistedCount > 0) console.log(chalk.green(`Skipping ${whitelistedCount} whitelisted sender(s).`));

  if (activeGroups.length === 0) {
    printSummary(stats);
    console.log(chalk.green.bold('All sender groups classified and processed. Done!'));
    clearCheckpoint();
    return;
  }

  const totalEmails = activeGroups.reduce((s, g) => s + g.count, 0);
  console.log('');
  console.log(chalk.bold.cyan(`Found ${fmt(activeGroups.length)} sender groups totalling ${fmt(totalEmails)} emails.`));
  console.log(chalk.gray('Groups are sorted by email count — biggest noise sources first.\n'));

  // -------------------------------------------------------------------------
  // Stage 0: Saved rules pass
  // -------------------------------------------------------------------------

  const rulesMatched = [];
  const afterRules = [];

  for (const group of activeGroups) {
    const rule = getRuleForSender(rules, group.email);
    if (rule) rulesMatched.push({ group, rule });
    else afterRules.push(group);
  }

  if (rulesMatched.length > 0) {
    const ruleBreakdown = {};
    for (const { rule } of rulesMatched) {
      ruleBreakdown[rule.action] = (ruleBreakdown[rule.action] ?? 0) + 1;
    }
    console.log(chalk.bold(`Applying ${fmt(rulesMatched.length)} saved rule(s)…`));
    if (ruleBreakdown.delete)  console.log(chalk.red(`  → ${fmt(ruleBreakdown.delete)} will be deleted`));
    if (ruleBreakdown.archive) console.log(chalk.blue(`  → ${fmt(ruleBreakdown.archive)} will be archived`));
    if (ruleBreakdown.keep)    console.log(chalk.green(`  → ${fmt(ruleBreakdown.keep)} will be kept`));

    const applyRules = auto ? true : await askYN(chalk.bold('\nApply saved rules?'));

    if (applyRules) {
      const spinner = ora({ text: chalk.cyan('Applying saved rules…'), color: 'cyan' }).start();
      for (const { group, rule } of rulesMatched) {
        try {
          await executeAction(rule.action, group, provider, authToken, dryRun, rule.folder ?? null);
          recordStat(stats, rule.action, group);
        } catch {
          recordStat(stats, 'skip', group);
        }
        processedEmails.push(...group.ids);
        reportActions.push({ email: group.email, name: group.name, count: group.count, action: rule.action, folder: rule.folder ?? null, reason: 'saved rule', category: null });
        persistCheckpoint();
      }
      spinner.succeed(chalk.cyan(`Applied ${fmt(rulesMatched.length)} saved rule(s).`));
    } else {
      console.log(chalk.gray('  Skipping saved rules — will review manually.'));
      for (const { group } of rulesMatched) afterRules.push(group);
      afterRules.sort((a, b) => b.count - a.count);
    }
  }

  // -------------------------------------------------------------------------
  // Stage 1: Keyword pre-pass
  // -------------------------------------------------------------------------

  const autoGroups = [];
  const reviewGroups = [];

  for (const group of afterRules) {
    const classification = classifyByKeywords(group);
    if (classification) autoGroups.push({ group, classification });
    else reviewGroups.push(group);
  }

  const kwCounts = {};
  for (const { classification } of autoGroups) {
    kwCounts[classification.action] = (kwCounts[classification.action] ?? 0) + 1;
  }

  console.log(chalk.bold(`Auto-classifying ${fmt(autoGroups.length)} sender(s) by keyword rules…`));
  if (kwCounts.delete)  console.log(chalk.red(`  → ${fmt(kwCounts.delete)} will be deleted`));
  if (kwCounts.archive) console.log(chalk.blue(`  → ${fmt(kwCounts.archive)} will be archived`));
  if (kwCounts.keep)    console.log(chalk.green(`  → ${fmt(kwCounts.keep)} will be kept`));

  if (autoGroups.length > 0) {
    const applyKeywords = auto ? true : await askYN(chalk.bold('\nApply these automatically?'));

    if (applyKeywords) {
      const spinnerKw = ora({ text: chalk.cyan('Applying keyword-matched actions…'), color: 'cyan' }).start();
      for (const { group, classification } of autoGroups) {
        const { action, category } = classification;
        const folder = (action === 'archive' && category && CATEGORY_FOLDERS[category]) ? CATEGORY_FOLDERS[category] : null;
        try {
          await executeAction(action, group, provider, authToken, dryRun, folder);
          recordStat(stats, action, group);
        } catch {
          recordStat(stats, 'skip', group);
        }
        processedEmails.push(...group.ids);
        reportActions.push({ email: group.email, name: group.name, count: group.count, action, folder, reason: classification.reason, category });
        persistCheckpoint();
      }
      spinnerKw.succeed(chalk.cyan(`Applied keyword rules to ${fmt(autoGroups.length)} sender(s).`));
    } else {
      console.log(chalk.gray('  Skipping keyword auto-actions — will review manually.'));
      for (const { group } of autoGroups) reviewGroups.push(group);
      reviewGroups.sort((a, b) => b.count - a.count);
    }
  }

  // -------------------------------------------------------------------------
  // Stage 2: Claude API pass
  // -------------------------------------------------------------------------

  let claudeClient = null;
  if (reviewGroups.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        claudeClient = new Anthropic({ apiKey });
      } catch {
        console.log(chalk.yellow('\n  Failed to initialise Anthropic client — skipping AI classification.'));
      }
    } else {
      console.log(chalk.yellow('\n  ANTHROPIC_API_KEY not set — skipping AI classification.'));
    }
  }

  const highConfidence = [];
  const needsReview = [];

  if (claudeClient && reviewGroups.length > 0) {
    console.log(chalk.bold(`\nConsulting Claude for remaining ${fmt(reviewGroups.length)} sender(s)…`));

    for (let i = 0; i < reviewGroups.length; i++) {
      const group = reviewGroups[i];
      process.stdout.write(chalk.gray(`  ${i + 1}/${reviewGroups.length} ${group.email}… `));
      try {
        const result = await classifyWithClaude(group, claudeClient);
        process.stdout.write(
          result.action === 'delete'  ? chalk.red(`${result.action} (${result.confidence})\n`)
          : result.action === 'archive' ? chalk.blue(`${result.action} (${result.confidence})\n`)
          : result.action === 'keep'    ? chalk.green(`${result.action} (${result.confidence})\n`)
          : chalk.yellow(`${result.action} (${result.confidence})\n`)
        );
        if (result.confidence === 'high' && result.action !== 'ask') highConfidence.push({ group, result });
        else needsReview.push({ group, result });
      } catch (err) {
        process.stdout.write(chalk.yellow(`failed\n`));
        console.log(chalk.yellow(`    Claude error: ${err.message}`));
        needsReview.push({ group, result: { action: 'ask', confidence: 'low', reason: 'Claude API error — please decide manually.', category: null } });
      }
      if (i < reviewGroups.length - 1) await new Promise((r) => setTimeout(r, 150));
    }
  } else {
    for (const group of reviewGroups) {
      needsReview.push({ group, result: { action: 'ask', confidence: 'low', reason: 'AI classification not available.', category: null } });
    }
  }

  // -------------------------------------------------------------------------
  // Stage 3: Apply high-confidence Claude decisions
  // -------------------------------------------------------------------------

  if (highConfidence.length > 0) {
    console.log(chalk.bold(`\nAuto-applying ${fmt(highConfidence.length)} high-confidence Claude decision(s)…`));
    for (const { group, result } of highConfidence) {
      const actionLabel = result.action === 'delete' ? chalk.red('Delete') : result.action === 'archive' ? chalk.blue('Archive') : chalk.green('Keep');
      console.log(`  → ${actionLabel}: ${chalk.gray(group.email)} — ${chalk.italic(result.reason)}`);
    }

    const applyHigh = auto ? true : await askYN(chalk.bold('\nApply these?'));

    if (applyHigh) {
      const spinnerHC = ora({ text: chalk.cyan('Applying high-confidence Claude actions…'), color: 'cyan' }).start();
      for (const { group, result } of highConfidence) {
        const folder = (result.action === 'archive' && result.category && CATEGORY_FOLDERS[result.category]) ? CATEGORY_FOLDERS[result.category] : null;
        try {
          await executeAction(result.action, group, provider, authToken, dryRun, folder);
          recordStat(stats, result.action, group);
        } catch {
          recordStat(stats, 'skip', group);
        }
        processedEmails.push(...group.ids);
        reportActions.push({ email: group.email, name: group.name, count: group.count, action: result.action, folder, reason: result.reason, category: result.category });
        persistCheckpoint();
      }
      spinnerHC.succeed(chalk.cyan(`Applied ${fmt(highConfidence.length)} high-confidence decision(s).`));
    } else {
      console.log(chalk.gray('  Skipping — moving to interactive review.'));
      needsReview.unshift(...highConfidence);
    }
  }

  // -------------------------------------------------------------------------
  // Stage 4: Interactive review
  // -------------------------------------------------------------------------

  if (needsReview.length === 0) {
    printSummary(stats);
    console.log(chalk.green.bold('All sender groups classified and processed. Done!'));
    if (report) saveReport(providerName, stats, reportActions);
    clearCheckpoint();
    return;
  }

  if (auto) {
    console.log('');
    console.log(chalk.bold.cyan(`[AUTO MODE] Processing ${fmt(needsReview.length)} remaining sender(s) automatically…`));
    for (const { group, result } of needsReview) {
      let action;
      if (result.confidence === 'medium' && result.action !== 'ask') {
        action = result.action;
        console.log(chalk.gray(`  Auto (medium): ${action} — ${group.email}`));
      } else {
        action = 'skip';
        console.log(chalk.gray(`  Auto (low/ask): skip — ${group.email}`));
      }
      const folder = (action === 'archive' && result.category && CATEGORY_FOLDERS[result.category]) ? CATEGORY_FOLDERS[result.category] : null;
      if (action === 'delete' || action === 'archive') {
        try { await executeAction(action, group, provider, authToken, dryRun, folder); } catch { action = 'skip'; }
      }
      recordStat(stats, action, group);
      processedEmails.push(...group.ids);
      reportActions.push({ email: group.email, name: group.name, count: group.count, action, folder, reason: result.reason, category: result.category });
      persistCheckpoint();
    }
    printSummary(stats);
    console.log(chalk.green.bold('All sender groups processed in auto mode. Done!'));
    if (report) saveReport(providerName, stats, reportActions);
    clearCheckpoint();
    return;
  }

  console.log('');
  console.log(chalk.bold.cyan(`Interactive review: ${fmt(needsReview.length)} sender(s) need your input.`));

  let quit = false;

  for (let i = 0; i < needsReview.length; i++) {
    if (quit) break;

    const { group, result } = needsReview[i];
    renderSenderCard(group, i, needsReview.length);

    // Show Claude's recommendation
    if (result.action !== 'ask' || result.confidence !== 'low' || result.reason !== 'AI classification not available.') {
      const recColor = result.action === 'delete' ? chalk.red : result.action === 'archive' ? chalk.blue : result.action === 'keep' ? chalk.green : chalk.yellow;
      console.log(`  ${chalk.bold('Claude:')} ${recColor(result.action.toUpperCase())} (${result.confidence} confidence)`);
      if (result.category) console.log(`  ${chalk.bold('Category:')} ${result.category}`);
      console.log(`  ${chalk.italic.gray(result.reason)}`);
    }

    const suggestedFolder = (result.action === 'archive' && result.category && CATEGORY_FOLDERS[result.category]) ? CATEGORY_FOLDERS[result.category] : null;
    const canUnsubscribe = result.category === 'newsletters' || result.action === 'delete';

    let action;
    if (result.confidence === 'medium' && result.action !== 'ask') {
      const recVerb = result.action;
      const recColor = recVerb === 'delete' ? chalk.red : recVerb === 'archive' ? chalk.blue : chalk.green;
      if (await askYN(`\n  Apply ${recColor(recVerb)}?`)) {
        action = recVerb;
      } else {
        action = await promptAction(group, { canUnsubscribe, suggestedFolder });
      }
    } else {
      action = await promptAction(group, { canUnsubscribe, suggestedFolder });
    }

    if (action === 'quit') { quit = true; }

    let resolvedFolder = suggestedFolder;
    let finalAction = action;

    if (!quit) {
      if (action === 'unsubscribe_delete') {
        // Fetch unsubscribe header and execute
        const spinner = ora({ text: chalk.cyan('Fetching unsubscribe info…'), color: 'cyan' }).start();
        let headerValue = null;
        let hasOneClick = false;
        if (provider.fetchListUnsubscribe) {
          const unsubHeaders = await provider.fetchListUnsubscribe(authToken, group.ids[0]);
          headerValue = unsubHeaders.headerValue;
          hasOneClick = unsubHeaders.hasOneClick;
        }
        spinner.stop();
        const parsed = parseUnsubscribeHeader(headerValue);
        if (parsed) {
          const unsubResult = await executeUnsubscribe(parsed, hasOneClick);
          if (unsubResult.success) {
            console.log(chalk.green(`  Unsubscribed via ${unsubResult.method}: ${unsubResult.detail}`));
          } else if (unsubResult.method === 'mailto') {
            console.log(chalk.yellow(`  Mailto unsubscribe — send an empty email to: ${unsubResult.detail}`));
          } else {
            console.log(chalk.yellow(`  Unsubscribe failed: ${unsubResult.detail}`));
          }
        } else {
          console.log(chalk.yellow('  No List-Unsubscribe header found — just deleting.'));
        }
        finalAction = 'delete';
        resolvedFolder = null;
      }

      if (finalAction === 'delete' || finalAction === 'archive') {
        try {
          await executeAction(finalAction, group, provider, authToken, dryRun, resolvedFolder);
        } catch {
          finalAction = 'skip';
          resolvedFolder = null;
        }
      }
    }

    const statAction = quit ? 'skip' : finalAction;
    recordStat(stats, statAction, group);
    processedEmails.push(...group.ids);
    reportActions.push({ email: group.email, name: group.name, count: group.count, action: statAction, folder: resolvedFolder, reason: result.reason, category: result.category });
    persistCheckpoint();

    // Save rule prompt (only for actionable decisions, not skip/quit)
    if (!quit && finalAction !== 'skip' && finalAction !== 'quit') {
      const saveRule = await askYN(`  Save rule for ${chalk.cyan(group.email)}?`);
      if (saveRule) {
        rules[group.email.toLowerCase()] = { action: finalAction === 'unsubscribe_delete' ? 'delete' : finalAction, folder: resolvedFolder };
        saveRules(rules);
        console.log(chalk.green(`  Rule saved.`));
      }
    }

    if (quit) {
      for (let j = i + 1; j < needsReview.length; j++) {
        recordStat(stats, 'skip', needsReview[j].group);
        processedEmails.push(...needsReview[j].group.ids);
      }
      persistCheckpoint();
    }
  }

  printSummary(stats);

  if (report) saveReport(providerName, stats, reportActions);

  if (!quit) {
    console.log(chalk.green.bold('All sender groups reviewed. Done!'));
    clearCheckpoint();
  } else {
    console.log(chalk.yellow('Stopped early. Run again to continue reviewing remaining senders.'));
  }
}
