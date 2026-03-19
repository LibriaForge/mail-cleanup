import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { createInterface } from 'readline';
import { classifyByKeywords, classifyWithClaude } from '../ai/classifier.js';
import { loadWhitelist } from '../whitelist.js';
import { saveCheckpoint, clearCheckpoint } from '../checkpoint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a large number with locale-aware comma separators.
 */
function fmt(n) {
  return n.toLocaleString();
}

/**
 * Ask a Y/N question and return true for Y, false for N.
 */
function askYN(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [Y/N]: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Render a visual header for the current sender group.
 */
function renderSenderCard(group, index, total) {
  const { email, name, count, subjects } = group;
  const displayName = name !== email ? chalk.bold(name) + chalk.gray(` <${email}>`) : chalk.bold(email);

  console.log('');
  console.log(chalk.bgBlue.white.bold(` Sender ${index + 1} of ${total} `));
  console.log(`  From  : ${displayName}`);
  console.log(`  Emails: ${chalk.yellow(fmt(count))}`);
  console.log(`  Subjects:`);
  for (const subject of subjects.slice(0, 3)) {
    console.log(`    ${chalk.gray('•')} ${subject}`);
  }
  if (subjects.length > 3) {
    console.log(chalk.gray(`    … and more`));
  }
}

/**
 * Prompt the user for an action for a single sender group via inquirer list.
 * Returns one of: 'delete' | 'archive' | 'keep' | 'skip' | 'quit'
 */
async function promptAction(group) {
  const { answers } = await inquirer.prompt([
    {
      type: 'list',
      name: 'answers',
      message: `What to do with ${chalk.yellow(fmt(group.count))} email(s) from this sender?`,
      choices: [
        { name: `Delete All   — permanently remove all ${fmt(group.count)} emails`, value: 'delete' },
        { name: `Archive All  — move out of inbox, mark as read`, value: 'archive' },
        { name: `Keep         — leave emails as they are`, value: 'keep' },
        { name: `Skip         — decide later`, value: 'skip' },
        new inquirer.Separator(),
        { name: `Quit         — stop and show summary`, value: 'quit' },
      ],
      pageSize: 7,
    },
  ]);
  return answers;
}

/**
 * Execute the chosen action using the provider's delete/archive functions.
 *
 * @param {string} action
 * @param {object} group
 * @param {object} provider - { deleteEmails, archiveEmails }
 * @param {*} authToken - auth object or access token
 * @param {boolean} [dryRun] - if true, skip actual API calls and just print what would happen
 */
async function executeAction(action, group, provider, authToken, dryRun = false) {
  if (action === 'keep' || action === 'skip') return;

  if (dryRun) {
    console.log(chalk.yellow(`  [DRY RUN] Would ${action} ${fmt(group.count)} email(s) from ${group.email}`));
    return;
  }

  const verb = action === 'delete' ? 'Deleting' : 'Archiving';
  const spinner = ora({
    text: chalk.cyan(`${verb} ${fmt(group.count)} email(s)…`),
    color: 'cyan',
  }).start();

  try {
    if (action === 'delete') {
      await provider.deleteEmails(authToken, group.ids);
      spinner.succeed(chalk.red(`Deleted ${fmt(group.count)} email(s) from ${group.email}.`));
    } else if (action === 'archive') {
      await provider.archiveEmails(authToken, group.ids);
      spinner.succeed(chalk.blue(`Archived ${fmt(group.count)} email(s) from ${group.email}.`));
    }
  } catch (err) {
    spinner.fail(chalk.red(`Failed to ${action} emails from ${group.email}: ${err.message}`));
    throw err;
  }
}

/**
 * Print a summary of all actions taken during the session.
 */
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

/**
 * Record an action in the running stats object.
 */
function recordStat(stats, action, group) {
  const key =
    action === 'delete' ? 'deleted'
    : action === 'archive' ? 'archived'
    : action === 'keep' ? 'kept'
    : 'skipped';

  stats[key].senders++;
  stats[key].emails += group.count;
  stats.total.senders++;
  stats.total.emails += group.count;
}

// ---------------------------------------------------------------------------
// Main review loop (AI-powered)
// ---------------------------------------------------------------------------

/**
 * Main interactive review loop with AI-powered auto-classification.
 *
 * Flow:
 *  1. Whitelist filter — silently keep whitelisted senders
 *  2. Keyword pre-pass → split into autoGroups / reviewGroups
 *  3. Apply keyword auto-actions (with Y/N confirmation, or auto in --auto mode)
 *  4. Claude API pass on reviewGroups → split into highConfidence / needsReview
 *  5. Apply high-confidence Claude decisions (with Y/N confirmation, or auto in --auto mode)
 *  6. Interactive loop for remaining (medium/low/ask) — skipped in --auto mode
 *  7. Summary
 *
 * @param {object[]} groups - sorted sender groups from the provider
 * @param {object} provider - { deleteEmails, archiveEmails }
 * @param {*} authToken - auth object or access token
 * @param {object} [flags] - CLI flags
 * @param {boolean} [flags.dryRun] - never call provider functions, just show what would happen
 * @param {boolean} [flags.auto] - skip all interactive prompts, apply automatically
 * @param {string} [flags.since] - ISO date filter (already applied upstream)
 * @param {object|null} [checkpoint] - loaded checkpoint data for resume (or null)
 * @param {string} [providerName] - 'gmail' | 'outlook', used for checkpoint saving
 */
export async function runReviewLoop(groups, provider, authToken, flags = {}, checkpoint = null, providerName = '') {
  const { dryRun = false, auto = false } = flags;

  if (groups.length === 0) {
    console.log(chalk.green('\nNo sender groups to review. Your inbox is clean!'));
    clearCheckpoint();
    return;
  }

  // -------------------------------------------------------------------------
  // Whitelist filtering
  // -------------------------------------------------------------------------

  const whitelist = loadWhitelist();
  const whitelistSet = new Set(whitelist.map((e) => e.toLowerCase().trim()));

  const stats = checkpoint?.stats ?? {
    deleted:  { senders: 0, emails: 0 },
    archived: { senders: 0, emails: 0 },
    kept:     { senders: 0, emails: 0 },
    skipped:  { senders: 0, emails: 0 },
    total:    { senders: 0, emails: 0 },
  };

  // Checkpoint tracking: accumulate processed IDs as the session progresses
  const processedEmails = checkpoint?.processedEmails ? [...checkpoint.processedEmails] : [];

  /** @type {object[]} groups after whitelist removal */
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

  if (whitelistedCount > 0) {
    console.log(chalk.green(`Skipping ${whitelistedCount} whitelisted sender(s).`));
  }

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

  // Helper: save checkpoint after each action
  const persistCheckpoint = () => {
    if (!providerName) return;
    saveCheckpoint({
      provider: providerName,
      createdAt: checkpoint?.createdAt ?? new Date().toISOString(),
      processedEmails,
      stats,
    });
  };

  // -------------------------------------------------------------------------
  // Stage 1: Keyword pre-pass
  // -------------------------------------------------------------------------

  /** @type {{ group: object, classification: { action: string, reason: string } }[]} */
  const autoGroups = [];
  /** @type {object[]} */
  const reviewGroups = [];

  for (const group of activeGroups) {
    const classification = classifyByKeywords(group);
    if (classification) {
      autoGroups.push({ group, classification });
    } else {
      reviewGroups.push(group);
    }
  }

  // Count keyword auto-action breakdown
  const kwCounts = { delete: 0, archive: 0, keep: 0 };
  for (const { classification } of autoGroups) {
    kwCounts[classification.action] = (kwCounts[classification.action] ?? 0) + 1;
  }

  console.log(chalk.bold(`Auto-classifying ${fmt(autoGroups.length)} sender(s) by keyword rules…`));
  if (autoGroups.length > 0) {
    if (kwCounts.delete > 0)  console.log(chalk.red(`  → ${fmt(kwCounts.delete)} will be deleted`));
    if (kwCounts.archive > 0) console.log(chalk.blue(`  → ${fmt(kwCounts.archive)} will be archived`));
    if (kwCounts.keep > 0)    console.log(chalk.green(`  → ${fmt(kwCounts.keep)} will be kept`));
  }

  if (autoGroups.length > 0) {
    // In auto mode, skip the Y/N prompt and just apply
    const applyKeywords = auto ? true : await askYN(chalk.bold('\nApply these automatically?'));

    if (applyKeywords) {
      const spinnerKw = ora({ text: chalk.cyan('Applying keyword-matched actions…'), color: 'cyan' }).start();
      for (const { group, classification } of autoGroups) {
        const { action } = classification;
        try {
          await executeAction(action, group, provider, authToken, dryRun);
          recordStat(stats, action, group);
          processedEmails.push(...group.ids);
          persistCheckpoint();
        } catch {
          recordStat(stats, 'skip', group);
          processedEmails.push(...group.ids);
          persistCheckpoint();
        }
      }
      spinnerKw.succeed(chalk.cyan(`Applied keyword rules to ${fmt(autoGroups.length)} sender(s).`));
    } else {
      console.log(chalk.gray('  Skipping keyword auto-actions — will review manually.'));
      // Move all auto-groups into reviewGroups so user sees them in the interactive loop
      for (const { group } of autoGroups) {
        reviewGroups.push(group);
      }
      // Re-sort by count desc to keep consistent ordering
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
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        claudeClient = new Anthropic({ apiKey });
      } catch {
        console.log(chalk.yellow('\n  @anthropic-ai/sdk not installed — skipping AI classification.'));
        console.log(chalk.gray('  Run: npm install @anthropic-ai/sdk\n'));
      }
    } else {
      console.log(chalk.yellow('\n  ANTHROPIC_API_KEY not set — skipping AI classification.'));
      console.log(chalk.gray('  Add it to .env to enable Claude-powered auto-classification.\n'));
    }
  }

  /** @type {{ group: object, result: { action: string, confidence: string, reason: string } }[]} */
  const highConfidence = [];
  /** @type {{ group: object, result: { action: string, confidence: string, reason: string } }[]} */
  const needsReview = [];

  if (claudeClient && reviewGroups.length > 0) {
    console.log(chalk.bold(`\nConsulting Claude for remaining ${fmt(reviewGroups.length)} sender(s)…`));

    for (let i = 0; i < reviewGroups.length; i++) {
      const group = reviewGroups[i];
      process.stdout.write(chalk.gray(`  ${i + 1}/${reviewGroups.length} ${group.email}… `));

      try {
        const result = await classifyWithClaude(group, claudeClient);
        process.stdout.write(
          result.action === 'delete' ? chalk.red(`${result.action} (${result.confidence})\n`)
          : result.action === 'archive' ? chalk.blue(`${result.action} (${result.confidence})\n`)
          : result.action === 'keep' ? chalk.green(`${result.action} (${result.confidence})\n`)
          : chalk.yellow(`${result.action} (${result.confidence})\n`)
        );

        if (result.confidence === 'high' && result.action !== 'ask') {
          highConfidence.push({ group, result });
        } else {
          needsReview.push({ group, result });
        }
      } catch (err) {
        process.stdout.write(chalk.yellow(`failed\n`));
        console.log(chalk.yellow(`    Claude error: ${err.message}`));
        // Fall back: add to manual review with no AI recommendation
        needsReview.push({ group, result: { action: 'ask', confidence: 'low', reason: 'Claude API error — please decide manually.' } });
      }

      // Small delay to avoid hitting Anthropic rate limits on large batches
      if (i < reviewGroups.length - 1) await new Promise((r) => setTimeout(r, 150));
    }
  } else {
    // No Claude — all remaining groups go straight to interactive review
    for (const group of reviewGroups) {
      needsReview.push({ group, result: { action: 'ask', confidence: 'low', reason: 'AI classification not available.' } });
    }
  }

  // -------------------------------------------------------------------------
  // Stage 3: Apply high-confidence Claude decisions
  // -------------------------------------------------------------------------

  if (highConfidence.length > 0) {
    console.log(chalk.bold(`\nAuto-applying ${fmt(highConfidence.length)} high-confidence Claude decision(s)…`));

    for (const { group, result } of highConfidence) {
      const actionLabel =
        result.action === 'delete' ? chalk.red('Delete')
        : result.action === 'archive' ? chalk.blue('Archive')
        : chalk.green('Keep');
      console.log(`  → ${actionLabel}: ${chalk.gray(group.email)} — ${chalk.italic(result.reason)}`);
    }

    // In auto mode, skip the Y/N prompt and just apply
    const applyHigh = auto ? true : await askYN(chalk.bold('\nApply these?'));

    if (applyHigh) {
      const spinnerHC = ora({ text: chalk.cyan('Applying high-confidence Claude actions…'), color: 'cyan' }).start();
      for (const { group, result } of highConfidence) {
        try {
          await executeAction(result.action, group, provider, authToken, dryRun);
          recordStat(stats, result.action, group);
          processedEmails.push(...group.ids);
          persistCheckpoint();
        } catch {
          recordStat(stats, 'skip', group);
          processedEmails.push(...group.ids);
          persistCheckpoint();
        }
      }
      spinnerHC.succeed(chalk.cyan(`Applied ${fmt(highConfidence.length)} high-confidence decision(s).`));
    } else {
      console.log(chalk.gray('  Skipping — moving to interactive review.'));
      // Insert at beginning of needsReview so user sees them next
      needsReview.unshift(...highConfidence);
    }
  }

  // -------------------------------------------------------------------------
  // Stage 4: Interactive review for medium/low confidence + ask
  // -------------------------------------------------------------------------

  if (needsReview.length === 0) {
    printSummary(stats);
    console.log(chalk.green.bold('All sender groups classified and processed. Done!'));
    clearCheckpoint();
    return;
  }

  // In auto mode: handle medium/low without prompting, then skip interactive loop
  if (auto) {
    console.log('');
    console.log(chalk.bold.cyan(`[AUTO MODE] Processing ${fmt(needsReview.length)} remaining sender(s) automatically…`));

    for (const { group, result } of needsReview) {
      let action;

      if (result.confidence === 'medium' && result.action !== 'ask') {
        // Medium confidence: auto-apply the recommendation
        action = result.action;
        console.log(chalk.gray(`  Auto (medium): ${action} — ${group.email}`));
      } else {
        // Low confidence / ask: default to skip
        action = 'skip';
        console.log(chalk.gray(`  Auto (low/ask): skip — ${group.email}`));
      }

      if (action === 'delete' || action === 'archive') {
        try {
          await executeAction(action, group, provider, authToken, dryRun);
        } catch {
          action = 'skip';
        }
      }

      recordStat(stats, action, group);
      processedEmails.push(...group.ids);
      persistCheckpoint();
    }

    printSummary(stats);
    console.log(chalk.green.bold('All sender groups processed in auto mode. Done!'));
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

    // Show Claude's recommendation if available
    if (result.action !== 'ask' || result.confidence !== 'low' || result.reason !== 'AI classification not available.') {
      const recColor =
        result.action === 'delete' ? chalk.red
        : result.action === 'archive' ? chalk.blue
        : result.action === 'keep' ? chalk.green
        : chalk.yellow;

      console.log(`  ${chalk.bold('Claude:')} ${recColor(result.action.toUpperCase())} (${result.confidence} confidence)`);
      console.log(`  ${chalk.italic.gray(result.reason)}`);
    }

    let action;

    if (result.confidence === 'medium' && result.action !== 'ask') {
      // Medium confidence: offer quick Y/N for the recommendation or full menu
      const recVerb = result.action;
      const recColor =
        recVerb === 'delete' ? chalk.red
        : recVerb === 'archive' ? chalk.blue
        : chalk.green;

      if (await askYN(`\n  Apply ${recColor(recVerb)}?`)) {
        action = recVerb;
      } else {
        action = await promptAction(group);
      }
    } else {
      // Low confidence or ask: full menu
      action = await promptAction(group);
    }

    if (action === 'quit') {
      quit = true;
    }

    if (!quit && (action === 'delete' || action === 'archive')) {
      try {
        await executeAction(action, group, provider, authToken, dryRun);
      } catch {
        action = 'skip';
      }
    }

    recordStat(stats, quit ? 'skip' : action, group);
    processedEmails.push(...group.ids);
    persistCheckpoint();

    if (quit) {
      // Count remaining as skipped
      for (let j = i + 1; j < needsReview.length; j++) {
        recordStat(stats, 'skip', needsReview[j].group);
        processedEmails.push(...needsReview[j].group.ids);
      }
      persistCheckpoint();
    }
  }

  printSummary(stats);

  if (!quit) {
    console.log(chalk.green.bold('All sender groups reviewed. Done!'));
    clearCheckpoint();
  } else {
    console.log(chalk.yellow('Stopped early. Run again to continue reviewing remaining senders.'));
    // Checkpoint is already saved — leave it for next run
  }
}
