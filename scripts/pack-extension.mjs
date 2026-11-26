// Builds the URKTV extension and puts a zip of it on the site (public/urktv-extension.zip) for installing.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
execFileSync('node', ['build.mjs'], { cwd: 'extension', stdio: 'inherit' });
rmSync('public/urktv-extension.zip', { force: true });
execFileSync('zip', ['-qr', '../../public/urktv-extension.zip', '.'], { cwd: 'extension/dist', stdio: 'inherit' });
console.log('public/urktv-extension.zip ready');
