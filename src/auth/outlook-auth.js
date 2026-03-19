import { PublicClientApplication } from '@azure/msal-node';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = join(__dirname, '../../tokens/outlook-token.json');
const TOKENS_DIR = join(__dirname, '../../tokens');

const SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
];

function loadSavedToken() {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
    // Check expiry with 5-minute buffer
    if (data.expiresAt && data.expiresAt > Date.now() + 5 * 60 * 1000) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

function saveToken(tokenData) {
  if (!existsSync(TOKENS_DIR)) {
    mkdirSync(TOKENS_DIR, { recursive: true });
  }
  writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));
}

export async function authenticateOutlook() {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const tenantId = process.env.OUTLOOK_TENANT_ID || 'common';

  if (!clientId) {
    throw new Error(
      'Missing Outlook credentials. Set OUTLOOK_CLIENT_ID in your .env file.\n' +
      'See .env.example for instructions on obtaining credentials.'
    );
  }

  // Try cached token first
  const cached = loadSavedToken();
  if (cached) {
    console.log(chalk.green('Outlook: using saved authentication token.'));
    return cached.accessToken;
  }

  const msalConfig = {
    auth: {
      clientId,
      // 9188040d... is the dedicated Microsoft personal accounts tenant
      authority: `https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad`,
    },
  };

  const pca = new PublicClientApplication(msalConfig);

  // Try silent auth via cached MSAL account first
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const silentResult = await pca.acquireTokenSilent({
        scopes: SCOPES,
        account: accounts[0],
      });
      const tokenData = {
        accessToken: silentResult.accessToken,
        expiresAt: silentResult.expiresOn?.getTime() ?? Date.now() + 3600 * 1000,
      };
      saveToken(tokenData);
      console.log(chalk.green('Outlook: silently refreshed authentication token.'));
      return silentResult.accessToken;
    } catch {
      // Fall through to device code flow
    }
  }

  // Device code flow — no local server needed
  console.log(chalk.cyan('\nStarting Outlook device code authentication...'));

  const deviceCodeResponse = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      const msg = response.message ?? `Go to ${response.verificationUri} and enter code: ${response.userCode}`;
      console.log(chalk.yellow('\n' + msg));
    },
  });

  const tokenData = {
    accessToken: deviceCodeResponse.accessToken,
    expiresAt: deviceCodeResponse.expiresOn?.getTime() ?? Date.now() + 3600 * 1000,
  };
  saveToken(tokenData);

  console.log(chalk.green('\nOutlook authentication successful. Token saved.'));
  return deviceCodeResponse.accessToken;
}
