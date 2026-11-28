// Local macOS bundle. Optional machine-local certificate; no notarization or publication.
import { packager } from "@electron/packager";
import { createReadStream } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectMacSigning, loadMacSigning, macSigningOptions } from "./macos-signing.mjs";
import { desktopSource } from "../../dev/desktop-test-env.mjs";

if (process.platform !== "darwin") throw new Error("Build this local macOS app on a Mac.");
const directory = dirname(fileURLToPath(import.meta.url));
const signing = await loadMacSigning();
const require = createRequire(import.meta.url);
const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
const electronVersion = pkg.devDependencies.electron;
if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) throw new Error("Pin the Electron version before packaging.");
const out = resolve(process.env.AGENTSTUDIO_MAC_OUTPUT || join(directory, "dist"));
const buildDir = resolve(process.env.AGENTSTUDIO_MAC_BUILD_DIR || join(directory, "out"));
if (process.env.AGENTSTUDIO_MAC_BUILD_DIR) {
  const built = JSON.parse(await readFile(join(buildDir, "main/build-info.json"), "utf8"));
  const source = desktopSource(resolve(directory, "../.."));
  if (built.revision !== source.revision || built.fingerprint !== source.fingerprint) {
    throw new Error("External Electron build does not match this checkout.");
  }
}
const zipDirectory = process.env.ELECTRON_ZIP_DIR;
if (zipDirectory) {
  const name = `electron-v${electronVersion}-darwin-${process.arch}.zip`;
  const checksums = JSON.parse(await readFile(join(dirname(require.resolve("electron/package.json")), "checksums.json"), "utf8"));
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(join(zipDirectory, name))) digest.update(chunk);
  const actual = digest.digest("hex");
  if (actual !== checksums[name]) throw new Error("The local Electron archive does not match its pinned checksum.");
}

// Main and utility code are bundled or use built-in Node modules. A staging
// directory with no node_modules prevents accidentally shipping local profiles.
const main = await readFile(join(buildDir, "main/index.js"), "utf8");
const allowed = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), "electron"]);
for (const match of main.matchAll(/require\(["']([^"']+)["']\)/g)) {
  if (!match[1].startsWith(".") && !allowed.has(match[1])) throw new Error(`Unbundled main dependency: ${match[1]}`);
}
const stage = await mkdtemp(join(tmpdir(), "agentstudio-package-"));
try {
  await mkdir(out, { recursive: true });
  await cp(buildDir, join(stage, "out"), { recursive: true });
  await writeFile(join(stage, "package.json"), JSON.stringify({
    name: "agentstudio", productName: "AgentRoom", version: pkg.version,
    private: true, main: "out/main/index.js",
  }, null, 2));
  const paths = await packager({
    dir: stage, out, platform: "darwin", arch: process.arch,
    name: "AgentRoom", executableName: "AgentRoom",
    appBundleId: "com.cubxxw.agentstudio", appVersion: pkg.version,
    electronVersion, ...(zipDirectory ? { electronZipDir: zipDirectory } : {}),
    icon: join(directory, "resources/icon.icns"),
    asar: false, prune: false, overwrite: false,
    darwinDarkModeSupport: true,
    osxSign: macSigningOptions(signing),
  });
  if (paths.length !== 1) throw new Error("Expected exactly one local application bundle.");
  const bundle = join(paths[0], "AgentRoom.app");
  const signatureReceipt = await inspectMacSigning(bundle, signing);
  const ui = await readFile(join(bundle, "Contents/Resources/app/out/renderer/personal/index.html"));
  const receipt = {
    bundle, electron: electronVersion, arch: process.arch,
    ...signatureReceipt, hardenedRuntime: false, notarized: false,
    uiEntrySha256: createHash("sha256").update(ui).digest("hex"),
    sourceRef: execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: directory, encoding: "utf8" }).trim()),
  };
  await writeFile(join(paths[0], "build-receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  await rm(stage, { recursive: true, force: true });
}
