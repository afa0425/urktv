// Builds the URKTV extension and puts a zip of it on the site (public/urktv-extension.zip) for installing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
execFileSync('node', ['build.mjs'], { cwd: 'extension', stdio: 'inherit' });
rmSync('public/urktv-extension.zip', { force: true });
execFileSync('zip', ['-qr', '../../public/urktv-extension.zip', '.'], { cwd: 'extension/dist', stdio: 'inherit' });
// the install page reads this to tell people whether they need to update
mkdirSync('public/ext', { recursive: true });
writeFileSync('public/ext/version.txt', JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version);
console.log('public/urktv-extension.zip ready');
