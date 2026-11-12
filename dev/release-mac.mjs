// Archive an already built clean-source Mac package; does not upload or notarize.
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || !process.argv[2]) throw new Error('Usage on macOS: node dev/release-mac.mjs <package-output-directory>');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git(['status', '--porcelain'])) throw new Error('Release archives require a clean checkout.');
const sourceRef = git(['rev-parse', 'HEAD']);
const pkg = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
const folder = resolve(process.argv[2], `AgentRoom-darwin-${process.arch}`);
const bundle = join(folder, 'AgentRoom.app');
const receipt = JSON.parse(await readFile(join(folder, 'build-receipt.json'), 'utf8'));
const info = JSON.parse(await readFile(join(bundle, 'Contents/Resources/app/out/main/build-info.json'), 'utf8'));
const bundled = JSON.parse(await readFile(join(bundle, 'Contents/Resources/app/package.json'), 'utf8'));
if (receipt.dirty || receipt.sourceRef !== sourceRef || info.revision !== sourceRef || bundled.version !== pkg.version) throw new Error('Package version/source does not match this clean checkout.');
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
const releaseDir = resolve(process.argv[2], 'release');
await mkdir(releaseDir, { recursive: true });
const asset = `AgentRoom-${pkg.version}-macOS-${process.arch}.zip`;
execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, join(releaseDir, asset)]);
const hash = createHash('sha256');
for await (const chunk of createReadStream(join(releaseDir, asset))) hash.update(chunk);
const sha256 = hash.digest('hex');
// Public provenance excludes machine-local paths and certificate identifiers.
const provenance = { version: pkg.version, sourceRef, asset, sha256, electron: receipt.electron, architecture: receipt.arch,
  signing: receipt.signed, notarized: receipt.notarized === true, hardenedRuntime: receipt.hardenedRuntime === true,
  uiEntrySha256: receipt.uiEntrySha256 };
await writeFile(join(releaseDir, 'release.json'), JSON.stringify(provenance, null, 2) + '\n');
await writeFile(join(releaseDir, 'SHA256SUMS.txt'), `${sha256}  ${asset}\n`);
console.log(JSON.stringify({ releaseDir, ...provenance }));
