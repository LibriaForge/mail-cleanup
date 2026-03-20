import { PublicClientApplication } from '@azure/msal-node';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { OUTLOOK_CLIENT_ID as BAKED_CLIENT_ID } from '../credentials.js';

const TOKENS_DIR = join(process.cwd(), 'tokens');
const MSAL_CACHE_PATH = join(TOKENS_DIR, 'outlook-msal-cache.json');

const SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'offline_access', // ensures a refresh token is issued
];

/**
 * MSAL cache plugin that persists the full token cache (including refresh token)
 * to disk so silent re-auth works across process restarts.
 * Refresh tokens for personal MSA accounts last ~90 days.
 */
function makeCachePlugin() {
  return {
    beforeCacheAccess(cacheContext) {
      if (existsSync(MSAL_CACHE_PATH)) {
        try {
          cacheContext.tokenCache.deserialize(readFileSync(MSAL_CACHE_PATH, 'utf8'));
        } catch { /* corrupt cache — start fresh */ }
      }
    },
    afterCacheAccess(cacheContext) {
      if (cacheContext.cacheHasChanged) {
        if (!existsSync(TOKENS_DIR)) mkdirSync(TOKENS_DIR, { recursive: true });
        writeFileSync(MSAL_CACHE_PATH, cacheContext.tokenCache.serialize());
      }
    },
  };
}

export async function authenticateOutlook() {
  const clientId = BAKED_CLIENT_ID || process.env.OUTLOOK_CLIENT_ID;

  if (!clientId) {
    throw new Error(
      'Missing Outlook credentials. Set OUTLOOK_CLIENT_ID in your .env file.\n' +
      'See .env.example for instructions on obtaining credentials.'
    );
  }

  const pca = new PublicClientApplication({
    auth: {
      clientId,
      // 9188040d... is the dedicated Microsoft personal accounts tenant
      authority: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad',
    },
    cache: { cachePlugin: makeCachePlugin() },
  });

  // Try silent auth using the persisted cache (refresh token path)
  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const result = await pca.acquireTokenSilent({ scopes: SCOPES, account: accounts[0] });
      console.log(chalk.green('Outlook: silently refreshed authentication token.'));
      return result.accessToken;
    } catch {
      // Refresh token expired or revoked — fall through to device code
    }
  }

  // Device code flow — only needed once every ~90 days
  console.log(chalk.cyan('\nStarting Outlook device code authentication...'));

  const result = await pca.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      const msg = response.message ?? `Go to ${response.verificationUri} and enter code: ${response.userCode}`;
      console.log(chalk.yellow('\n' + msg));
    },
  });

  console.log(chalk.green('\nOutlook authentication successful. Token cached — next run will be automatic.'));
  return result.accessToken;
}
