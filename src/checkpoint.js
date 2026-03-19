import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_PATH = join(__dirname, '../checkpoint.json');

/**
 * Load the checkpoint file from the project root.
 * Returns null if no checkpoint file exists or if it is malformed.
 *
 * @returns {{ provider: string, createdAt: string, processedEmails: string[], stats: object } | null}
 */
export function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
    if (data && typeof data === 'object' && data.provider) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Save checkpoint data to checkpoint.json.
 *
 * @param {{ provider: string, createdAt: string, processedEmails: string[], stats: object }} data
 */
export function saveCheckpoint(data) {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify(data, null, 2));
}

/**
 * Delete checkpoint.json if it exists.
 */
export function clearCheckpoint() {
  if (existsSync(CHECKPOINT_PATH)) {
    try {
      unlinkSync(CHECKPOINT_PATH);
    } catch {
      // Ignore errors — checkpoint cleanup is best-effort
    }
  }
}
