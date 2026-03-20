/**
 * Publish a GitHub release for the current package.json version.
 *
 * Usage: npm run release
 *
 * What it does:
 *   1. Reads version from package.json
 *   2. Builds the Windows exe (build:win)
 *   3. Creates and pushes a git tag vX.Y.Z
 *   4. Creates a GitHub release with the exe attached via `gh`
 *
 * Requirements: gh CLI must be installed and authenticated.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const version = pkg.version;
const tag = `v${version}`;

function run(cmd) {
  console.log(`$ ${cmd}`);
  // Wrap in PowerShell with Chocolatey profile so PATH includes gh, bun, etc.
  execSync(
    `powershell -Command "& { Import-Module 'C:/ProgramData/chocolatey/helpers/chocolateyProfile.psm1' -ErrorAction SilentlyContinue; refreshenv; ${cmd.replace(/"/g, '\\"')} }"`,
    { stdio: 'inherit' }
  );
}

// 1. Build
console.log(`\nBuilding ${tag}…`);
run('npm run build:win');

// 2. Tag (skip if already exists)
try {
  execSync(`git rev-parse ${tag}`, { stdio: 'ignore' });
  console.log(`\nTag ${tag} already exists — skipping tag creation.`);
} catch {
  run(`git tag ${tag}`);
  run(`git push origin ${tag}`);
}

// 3. GitHub release — write notes to a temp file to avoid quoting issues
const notes = [
  `## ${tag}`,
  '',
  '**Windows x64 — single executable, no install required.**',
  '',
  '> If Windows Defender or your AV flags the file, this is a false positive common',
  '> with Bun-compiled binaries. Add an exception for the `dist/` folder.',
  '',
  'See the [README](https://github.com/LibriaForge/mail-cleanup#readme) for setup instructions.',
].join('\n');

const notesFile = join(tmpdir(), `release-notes-${tag}.md`);
writeFileSync(notesFile, notes, 'utf-8');

try {
  run(`gh release create ${tag} dist/mail-cleanup.exe --title "Mail Cleanup ${tag}" --notes-file "${notesFile}"`);
} finally {
  unlinkSync(notesFile);
}

console.log(`\nDone! Release ${tag} published.`);
