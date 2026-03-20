import { createRequire } from 'module';
const { rcedit } = createRequire(import.meta.url)('rcedit');
import { readFileSync } from 'fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf-8'));

await rcedit('dist/mail-cleanup.exe', {
  'version-string': {
    FileDescription:  'LibriaForge Mail Cleanup',
    ProductName:      'Mail Cleanup',
    CompanyName:      'LibriaForge',
    LegalCopyright:   '© 2026 LibriaForge',
    OriginalFilename: 'mail-cleanup.exe',
  },
  'file-version':    version,
  'product-version': version,
});

console.log(`Patched exe metadata (v${version}).`);
