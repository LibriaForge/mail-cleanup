# mail-cleanup

An interactive CLI tool to bulk-clean Gmail and Outlook inboxes. Supports AI-powered auto-classification via the Claude API to automatically delete, archive, or flag emails for manual review.

## How it works

1. **Keyword pre-pass** — obvious noise (noreply senders, marketing domains, promotional subjects) is auto-classified instantly
2. **Claude API pass** — remaining senders are sent to Claude Haiku for classification with a confidence rating
3. **High-confidence auto-apply** — clear decisions are batched and applied with a single Y/N confirmation
4. **Interactive review** — uncertain cases are shown one by one with Claude's recommendation

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure credentials

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

#### Gmail
- Go to [Google Cloud Console](https://console.cloud.google.com)
- Enable the **Gmail API**
- Create an **OAuth 2.0 Client ID** (Desktop app type)
- Add `http://localhost:3000/oauth2callback` as an authorized redirect URI
- Add your Gmail address as a test user under the OAuth consent screen
- Copy the Client ID and Secret into `.env`

#### Outlook
- Go to [Azure Portal](https://portal.azure.com) → App registrations → New registration
- Under Authentication, add platform **Mobile and desktop applications**
- Enable **Allow public client flows**
- Under API permissions, add delegated Microsoft Graph permissions: `Mail.Read`, `Mail.ReadWrite`
- In the Manifest editor, set `"accessTokenAcceptedVersion": 2` and `"signInAudience": "PersonalMicrosoftAccount"`
- Copy the Application (client) ID into `.env`

#### Claude API (optional, for AI classification)
- Go to [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key
- Copy the key into `.env`

### 3. Run

```bash
npm start
```

Authentication tokens are saved to `tokens/` after the first login so you won't need to re-authenticate on subsequent runs.

## Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview actions without deleting or archiving anything |
| `--auto` | Apply all decisions automatically, no prompts |
| `--since=YYYY-MM-DD` | Only process emails received on or before this date |
| `--whitelist` | Open the whitelist manager to add/remove always-kept senders |
| `DEBUG=1` | Show full error stack traces on failure |

Example:

```bash
npm start -- --dry-run --since=2024-12-31
```

## Actions

| Action  | Description |
|---------|-------------|
| Delete  | Permanently removes all emails from that sender |
| Archive | Moves emails out of inbox and marks as read — keeps them searchable |
| Keep    | Leaves emails exactly as they are |
| Skip    | Defers the decision to the next session |
| Quit    | Stops processing and shows a session summary |

## Confidentiality

- Credentials and tokens are stored locally in `.env` and `tokens/` — never committed to git
- Email content (sender, subject lines) is sent to the Anthropic API for classification if `ANTHROPIC_API_KEY` is set — no email bodies are ever read or transmitted
