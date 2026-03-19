/**
 * AI-powered email sender classifier.
 *
 * Stage 1 — keyword rules (instant, no API call).
 * Stage 2 — Claude Haiku via Anthropic SDK (for anything not matched by rules).
 */

// ---------------------------------------------------------------------------
// Stage 1: Keyword rules
// ---------------------------------------------------------------------------

const DELETE_EMAIL_PREFIXES = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'newsletter', 'newsletters', 'marketing', 'promo', 'promotions',
  'bulk', 'campaign', 'mailer', 'mailchimp', 'bounce',
];

const DELETE_DOMAIN_SEGMENTS = [
  '.marketing.', '.campaigns.', '.promo.', '.bulk.',
  '.email.', '.news.', '.newsletter.', '.mail.',
];

const DELETE_SUBJECT_PHRASES = [
  '% off', 'limited time', 'exclusive offer', 'special deal',
  'click to unsubscribe', "you've been selected", 'congratulations you',
];

const ARCHIVE_EMAIL_PREFIXES = [
  'notifications', 'notification', 'alerts', 'alert',
  'updates', 'update', 'digest', 'automated', 'system',
  'info', 'hello', 'team', 'support', 'billing', 'invoice',
  'receipt', 'order', 'shipment', 'delivery',
];

const ARCHIVE_SUBJECT_PHRASES = [
  'weekly digest', 'monthly digest', 'daily digest',
  'your summary', 'activity summary', 'order confirmation',
  'your receipt', 'invoice', 'your shipment', 'has shipped', 'delivery',
];

const KEEP_SUBJECT_PHRASES = [
  're:', 'fwd:', 'you asked', 'following up',
  'interview', 'offer', 'contract',
];

/**
 * Return the local part (before @) of an email address, lowercased.
 */
function localPart(email) {
  return (email.split('@')[0] ?? '').toLowerCase();
}

/**
 * Return the full domain (after @) of an email address, lowercased.
 */
function domain(email) {
  return (email.split('@')[1] ?? '').toLowerCase();
}

/**
 * True if the sender appears to be a real person (firstname.lastname pattern).
 */
function looksLikeRealPerson(email) {
  const local = localPart(email);
  // firstname.lastname or firstname_lastname, letters only in each segment
  return /^[a-z]+[._][a-z]+$/.test(local);
}

/**
 * Attempt to classify a sender group using keyword/pattern rules alone.
 *
 * @param {{ email: string, name: string, count: number, subjects: string[] }} group
 * @returns {{ action: 'delete'|'archive'|'keep', reason: string } | null}
 *   null means no rule matched — caller should use Claude.
 */
export function classifyByKeywords(group) {
  const { email, subjects = [] } = group;
  const local = localPart(email);
  const dom = domain(email);
  const subjectsLower = subjects.map((s) => s.toLowerCase());

  // --- DELETE rules ---

  if (DELETE_EMAIL_PREFIXES.some((prefix) => local.startsWith(prefix))) {
    return { action: 'delete', reason: `Sender address starts with a bulk/marketing prefix (${local}@…).` };
  }

  // Subdomain segment patterns: the domain must contain e.g. ".marketing." somewhere
  // We normalise to ".domain." so we can match both leading and trailing segments.
  const normDomain = `.${dom}.`;
  if (DELETE_DOMAIN_SEGMENTS.some((seg) => normDomain.includes(seg))) {
    return { action: 'delete', reason: `Sender domain contains a bulk-mail subdomain segment (${dom}).` };
  }

  if (subjectsLower.some((s) => DELETE_SUBJECT_PHRASES.some((phrase) => s.includes(phrase)))) {
    const matched = DELETE_SUBJECT_PHRASES.find((phrase) => subjectsLower.some((s) => s.includes(phrase)));
    return { action: 'delete', reason: `Subject contains promotional phrase: "${matched}".` };
  }

  // --- KEEP rules (check before ARCHIVE so personal mail isn't archived) ---

  if (looksLikeRealPerson(email)) {
    return { action: 'keep', reason: 'Sender address looks like a real person (firstname.lastname pattern).' };
  }

  if (subjectsLower.some((s) => KEEP_SUBJECT_PHRASES.some((phrase) => s.includes(phrase)))) {
    const matched = KEEP_SUBJECT_PHRASES.find((phrase) => subjectsLower.some((s) => s.includes(phrase)));
    return { action: 'keep', reason: `Subject suggests personal/work correspondence: "${matched}".` };
  }

  // --- ARCHIVE rules ---

  if (ARCHIVE_EMAIL_PREFIXES.some((prefix) => local.startsWith(prefix))) {
    return { action: 'archive', reason: `Sender address starts with an automated-notification prefix (${local}@…).` };
  }

  if (subjectsLower.some((s) => ARCHIVE_SUBJECT_PHRASES.some((phrase) => s.includes(phrase)))) {
    const matched = ARCHIVE_SUBJECT_PHRASES.find((phrase) => subjectsLower.some((s) => s.includes(phrase)));
    return { action: 'archive', reason: `Subject matches automated notification phrase: "${matched}".` };
  }

  // No rule matched
  return null;
}

// ---------------------------------------------------------------------------
// Stage 2: Claude API classification
// ---------------------------------------------------------------------------

/**
 * Classify a sender group using Claude Haiku.
 *
 * @param {{ email: string, name: string, count: number, subjects: string[] }} group
 * @param {import('@anthropic-ai/sdk').Anthropic} client  Anthropic SDK client instance
 * @returns {Promise<{ action: 'delete'|'archive'|'keep'|'ask', confidence: 'high'|'medium'|'low', reason: string }>}
 */
export async function classifyWithClaude(group, client) {
  const { name, email, count, subjects = [] } = group;

  const subjectList = subjects.length > 0
    ? subjects.map((s) => `  - ${s}`).join('\n')
    : '  (no subjects available)';

  const prompt = `You are helping clean up a cluttered email inbox. Analyze this sender and recommend an action.

Sender: ${name} <${email}>
Total emails: ${count}
Sample subjects:
${subjectList}

Reply with JSON only, no explanation outside the JSON:
{
  "action": "delete" | "archive" | "keep" | "ask",
  "confidence": "high" | "medium" | "low",
  "reason": "one short sentence"
}

Rules:
- delete: marketing, newsletters, promotions, social digests, crypto/trading digests, bulk announcements, no-reply bulk mail, expired offers
- archive: automated but potentially useful — receipts, order confirmations, account alerts, shipping, billing, bank statements
- keep: anything personal, anything needing a reply, job-related, legal, medical, financial advice from a real person
- ask: genuinely ambiguous — mixed signals, unclear sender purpose
- confidence high = obvious decision, apply automatically without asking user
- confidence medium = fairly sure, show recommendation and ask Y/N to confirm
- confidence low or action=ask = show recommendation, let user pick from full menu`;

  const message = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Extract JSON — Claude sometimes wraps it in a code fence
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude returned non-JSON response: ${text.slice(0, 120)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);

  // Validate and normalise fields
  const validActions = ['delete', 'archive', 'keep', 'ask'];
  const validConfidences = ['high', 'medium', 'low'];

  const action = validActions.includes(parsed.action) ? parsed.action : 'ask';
  const confidence = validConfidences.includes(parsed.confidence) ? parsed.confidence : 'low';
  const reason = typeof parsed.reason === 'string' ? parsed.reason : 'No reason provided.';

  return { action, confidence, reason };
}
