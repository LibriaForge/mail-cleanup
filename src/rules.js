import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, '../rules.json');

/** Load saved sender rules. Shape: { [email | "*@domain"]: { action, folder? } } */
export function loadRules() {
  if (!existsSync(RULES_PATH)) return {};
  try { return JSON.parse(readFileSync(RULES_PATH, 'utf8')); } catch { return {}; }
}

export function saveRules(rules) {
  writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2));
}

/** Exact match first, then wildcard domain match (*@domain.com). */
export function getRuleForSender(rules, email) {
  const key = email.toLowerCase();
  if (rules[key]) return rules[key];
  const domain = key.split('@')[1];
  return (domain && rules[`*@${domain}`]) ?? null;
}
