import { google } from 'googleapis';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import open from 'open';
import chalk from 'chalk';

const TOKEN_PATH = join(process.cwd(), 'tokens/gmail-token.json');
const TOKENS_DIR = join(process.cwd(), 'tokens');

const SCOPES = [
  'https://mail.google.com/',
];

const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

export function createOAuth2Client() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing Gmail credentials. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in your .env file.\n' +
      'See .env.example for instructions on obtaining credentials.'
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

function loadSavedToken(oauth2Client) {
  if (!existsSync(TOKEN_PATH)) return false;

  try {
    const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(token);

    // Check if token is expired and has no refresh token
    if (token.expiry_date && token.expiry_date < Date.now() && !token.refresh_token) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function saveToken(oauth2Client) {
  if (!existsSync(TOKENS_DIR)) {
    mkdirSync(TOKENS_DIR, { recursive: true });
  }
  writeFileSync(TOKEN_PATH, JSON.stringify(oauth2Client.credentials, null, 2));
}

async function getNewToken(oauth2Client) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log(chalk.cyan('\nOpening browser for Gmail authentication...'));
  console.log(chalk.gray('If the browser does not open, visit this URL manually:'));
  console.log(chalk.underline(authUrl));

  // Start local HTTP server to capture the OAuth callback
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:3000');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication failed</h1><p>You can close this tab.</p>');
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1>Authentication successful!</h1>' +
          '<p>You can close this tab and return to the terminal.</p>'
        );
        server.close();
        resolve(code);
      }
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start local server on port 3000: ${err.message}`));
    });

    server.listen(3000, () => {
      open(authUrl).catch(() => {
        // open() may fail silently on some systems — the URL is already printed
      });
    });
  });

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  saveToken(oauth2Client);

  console.log(chalk.green('Gmail authentication successful. Token saved.'));
  return oauth2Client;
}

export async function authenticateGmail() {
  const oauth2Client = createOAuth2Client();

  // Set up automatic token refresh saving
  oauth2Client.on('tokens', (tokens) => {
    if (!existsSync(TOKENS_DIR)) mkdirSync(TOKENS_DIR, { recursive: true });
    const current = existsSync(TOKEN_PATH)
      ? JSON.parse(readFileSync(TOKEN_PATH, 'utf8'))
      : {};
    writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }, null, 2));
  });

  if (loadSavedToken(oauth2Client)) {
    // Trigger a refresh if needed
    try {
      await oauth2Client.getAccessToken();
      console.log(chalk.green('Gmail: using saved authentication token.'));
      return oauth2Client;
    } catch {
      console.log(chalk.yellow('Saved Gmail token is invalid or expired. Re-authenticating...'));
    }
  }

  return getNewToken(oauth2Client);
}
