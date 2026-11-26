// Builds the URKTV extension and puts zips of it on the site for installing:
// public/urktv-extension.zip (latest) and public/ext/urktv-extension-<version>.zip for every
// release in extension/releases (kept in git so older versions stay downloadable).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
execFileSync('node', ['build.mjs'], { cwd: 'extension', stdio: 'inherit' });
const version = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;
rmSync('public/urktv-extension.zip', { force: true });
execFileSync('zip', ['-qr', '../../public/urktv-extension.zip', '.'], { cwd: 'extension/dist', stdio: 'inherit' });
copyFileSync('public/urktv-extension.zip', `extension/releases/${version}.zip`);
const list = JSON.parse(readFileSync('extension/releases/releases.json', 'utf8'));
if (!list.some((r) => r.version === version)) throw new Error(`add ${version} to extension/releases/releases.json`);
rmSync('public/ext', { recursive: true, force: true });
mkdirSync('public/ext');
const out = list
  .filter((r) => existsSync(`extension/releases/${r.version}.zip`))
  .map((r) => {
    copyFileSync(`extension/releases/${r.version}.zip`, `public/ext/urktv-extension-${r.version}.zip`);
    return { ...r, file: `ext/urktv-extension-${r.version}.zip`, latest: r.version === version };
  });
writeFileSync('public/ext/versions.json', JSON.stringify({ latest: version, versions: out }, null, 1));
console.log(`public/urktv-extension.zip ready (${version}), ${out.length} versions listed`);
