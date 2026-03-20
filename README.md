# mail-cleanup

An interactive CLI tool to bulk-clean Gmail and Outlook inboxes. Supports AI-powered auto-classification via the Claude API to automatically delete, archive, or flag emails for manual review.

## How it works

1. **Saved rules** — senders you've decided on before are applied instantly with no prompts
2. **Keyword pre-pass** — obvious noise (noreply senders, marketing domains, promotional subjects) is auto-classified instantly
3. **Claude API pass** — remaining senders are sent to Claude Haiku for classification with a confidence rating and category
4. **High-confidence auto-apply** — clear decisions are batched and applied with a single Y/N confirmation
5. **Interactive review** — uncertain cases are shown one by one with Claude's recommendation

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

## Download

Pre-built binaries are available in the [`dist/`](dist/) folder — no Node.js or Bun required.

| Platform | File |
|----------|------|
| Windows x64 | [`dist/mail-cleanup.exe`](dist/mail-cleanup.exe) |

Place the binary in any folder, create a `.env` file next to it with your credentials, and run it.

> **Antivirus false positive** — Some antivirus tools (including Avast) may flag the executable with a heuristic detection like `IDP.HELU.PSE69`. This is a known false positive that affects all self-contained binaries built with Bun, PyInstaller, and similar tools — the binary embeds a JavaScript runtime which looks unusual to heuristic scanners. The source code is fully open for inspection. To resolve: restore the file from quarantine and add the folder as an exception in your AV settings.

## Building a standalone executable

You can produce a single self-contained binary (no Node.js required on the target machine) using [Bun](https://bun.sh).

### Install Bun (build machine only)

```bash
npm install -g bun
# or: curl -fsSL https://bun.sh/install | bash
```

### Build

```bash
npm run build:win    # → dist/mail-cleanup.exe  (Windows x64)
npm run build:mac    # → dist/mail-cleanup-mac  (macOS x64)
npm run build:linux  # → dist/mail-cleanup-linux (Linux x64)
```

Or just `npm run build` to build for the current platform.

The output binary is fully self-contained. Distribute it alongside a `.env` file with the credentials — the binary will look for `.env` in the directory it is run from.

## Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview actions without deleting or archiving anything |
| `--auto` | Apply all decisions automatically, no prompts |
| `--since=YYYY-MM-DD` | Only process emails received on or before this date |
| `--whitelist` | Open the whitelist manager to add/remove always-kept senders |
| `--report` | Save a JSON session report to `reports/YYYY-MM-DD-HH-MM.json` |
| `DEBUG=1` | Show full error stack traces on failure |

Example:

```bash
npm start -- --dry-run --since=2024-12-31
npm start -- --auto --report
```

## Actions

| Action | Description |
|--------|-------------|
| Delete | Permanently removes all emails from that sender |
| Unsubscribe + Delete | Follows the `List-Unsubscribe` header then deletes — shown for newsletters |
| Archive | Moves emails to a named category folder and marks as read |
| Keep | Leaves emails exactly as they are |
| Skip | Defers the decision to the next session |
| Quit | Stops processing and shows a session summary |

After each manual decision you're asked whether to save it as a rule — next run that sender is handled automatically.

## Category folders

Emails are routed to named folders based on their detected category:

| Category | Folder |
|----------|--------|
| Newsletters / marketing | `Newsletters` |
| Receipts / orders / invoices | `Receipts` |
| Notifications / alerts | `Alerts` |
| Social media | `Social` |
| Finance / banking | `Finance` |
| Dev tools / GitHub / JIRA | `Dev` |
| Shopping / e-commerce | `Shopping` |
| Travel / hotels / flights | `Travel` |

Folders are created automatically if they don't exist.

## Sender rules

Decisions are saved to `rules.json` (gitignored). On subsequent runs the saved-rules pass runs first and applies them silently. You can also edit `rules.json` directly:

```json
{
  "noreply@github.com": { "action": "archive", "folder": "Dev" },
  "*@amazon.com": { "action": "archive", "folder": "Shopping" }
}
```

Wildcard domain entries (`*@domain.com`) match all senders from that domain.

## Confidentiality

- Credentials and tokens are stored locally in `.env` and `tokens/` — never committed to git
- Email content (sender, subject lines) is sent to the Anthropic API for classification if `ANTHROPIC_API_KEY` is set — no email bodies are ever read or transmitted
