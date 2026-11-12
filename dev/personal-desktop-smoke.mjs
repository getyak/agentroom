import { cleanDesktopTestEnv, launchDesktopTest } from './desktop-test-env.mjs';
// macOS native acceptance; synthetic local organization only, never a model call.
// Build the desktop app first, then: node dev/personal-desktop-smoke.mjs
// AGENTSTUDIO_DESKTOP_EVIDENCE_DIR sets the evidence parent (each run is unique).
// AGENTSTUDIO_ELECTRON_BINARY overrides the source-run Electron executable.
// AGENTSTUDIO_PACKAGED_APP selects an AgentRoom.app bundle instead: its own
// Contents/MacOS/AgentRoom is launched without a source-directory argument.
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin") throw new Error("This smoke requires macOS and an interactive desktop session.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireDesktop = createRequire(join(root, "apps/desktop/package.json"));
const requirePlaywright = createRequire(requireDesktop.resolve("@playwright/test"));
const { _electron } = requirePlaywright("playwright");
const { expect } = requireDesktop("@playwright/test");
const packagedApp = process.env.AGENTSTUDIO_PACKAGED_APP ? resolve(process.env.AGENTSTUDIO_PACKAGED_APP) : null;
const executable = packagedApp
  ? join(packagedApp, "Contents/MacOS/AgentRoom")
  : process.env.AGENTSTUDIO_ELECTRON_BINARY || requireDesktop("electron");
await access(executable);
const evidenceParent = resolve(process.env.AGENTSTUDIO_DESKTOP_EVIDENCE_DIR || join(root, "output/playwright/personal-desktop-smoke"));
await mkdir(evidenceParent, { recursive: true });
const output = await mkdtemp(join(evidenceParent, "smoke-"));
const profile = await mkdtemp(join(output, "profile-"));
const exportsDirectory = join(output, "exports");
const env = {
  ...process.env,
  AGENTSTUDIO_PI_BIN: '/agentstudio-synthetic-missing-pi', AGENTSTUDIO_CLAUDE_BIN: '/agentstudio-synthetic-missing-claude', AGENTSTUDIO_WORKSPACE: "personal",
  AGENTSTUDIO_USER_DATA_DIR: profile,
  AGENTSTUDIO_PERSONAL_EXPORT_DIR: exportsDirectory,
  AGENTSTUDIO_CODEX_BIN: join(profile, "missing-synthetic-codex-no-model-calls"),
  AGENTSTUDIO_MOCK_KEYCHAIN: "1",
  AGENTSTUDIO_TEST_NOTIFICATIONS: "1",
  AGENTSTUDIO_MOCK_KEYCHAIN: "1",
  PERSONAL_BUILD_REF: "personal-desktop-synthetic-smoke",
};
cleanDesktopTestEnv(env);
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "AGENTSTUDIO_PERSONAL_DATA_DIR", "PERSONAL_DATA_DIR"]) delete env[key];

const metadata = {
  synthetic: true,
  executionScope: "Deterministic local organization, not AI. Missing CLI; no real provider or remote connection.",
  output, profile, executable, packagedApp,
  checks: [], rendererErrors: [], captures: [], exports: [],
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const verify = (condition, name) => {
  if (!condition) throw new Error(name);
  metadata.checks.push(name);
  console.log(`PASS ${name}`);
};
let application, page;
const utilityPids = new Set();
const request = (path, body, method) => page.evaluate(async ({ path, body, method }) => {
  const response = await window.agentStudioPersonal.request({
    path: `/api${path}`, method: method || (body === undefined ? "GET" : "POST"),
    ...(body === undefined ? {} : { body }),
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`Synthetic API ${path}: HTTP ${response.status}`);
  return response.body;
}, { path, body, method });
const waitCompleted = async (id, artifactCount = 1) => {
  let thread;
  await expect.poll(async () => {
    thread = await request(`/threads/${id}`);
    return ["completed", "blocked", "failed", "unknown", "cancelled"].includes(thread.status);
  }, { timeout: 20_000, intervals: [100, 250, 500] }).toBe(true);
  verify(thread.status === "completed" && thread.artifacts.length === artifactCount, `local task completes with ${artifactCount} artifact(s)`);
  verify(thread.runs.every((run) => run.mode === "local" && (!run.chosenExecutor || run.chosenExecutor === "local")), "every synthetic run stays local; no AI execution");
  return thread;
};
const recordUtility = async () => {
  const entries = await application.evaluate(({ app }) => app.getAppMetrics()
    .filter((item) => item.name === "AgentRoom Personal Runtime")
    .map(({ pid, type, name, creationTime }) => ({ pid, type, name, creationTime })));
  for (const entry of entries) utilityPids.add(entry.pid);
  return entries;
};
async function capture(name) {
  // Explicit capturePage paints the native window before OS capture. A renderer
  // fallback is labelled in the receipt; it is never presented as an OS capture.
  const rendererFile = join(output, `${name}-renderer.png`);
  await page.screenshot({ path: rendererFile });
  const native = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const frame = await window.webContents.capturePage();
    return { mediaId: window.getMediaSourceId(), paintedSize: frame.getSize(), empty: frame.isEmpty() };
  });
  verify(!native.empty && native.paintedSize.width > 0, `native capture paints ${name}`);
  const nativeFile = join(output, `${name}.png`);
  try {
    if (process.env.AGENTROOM_AUTOMATION_VISIBLE !== "1") throw new Error("Background acceptance uses renderer capture");
    const windowId = native.mediaId.split(":")[1];
    if (!/^\d+$/.test(windowId || "")) throw new Error("No native window ID");
    execFileSync("screencapture", ["-x", "-l", windowId, nativeFile], { stdio: "ignore", timeout: 5000 });
    verify((await readFile(nativeFile)).byteLength > 0, `OS window capture saved: ${name}`);
    metadata.captures.push({ name, method: "native-window", file: nativeFile, rendererFile, paintedSize: native.paintedSize, fallback: false });
  } catch (error) {
    metadata.captures.push({ name, method: "renderer-fallback", file: rendererFile, rendererFile,
      nativeFile: null, fallback: true, fallbackReason: "OS window capture unavailable; renderer image only", errorCode: error.code || error.name });
    console.warn(`CAPTURE FALLBACK ${name}: OS capture unavailable; renderer-only evidence.`);
  }
}
const noPageOverflow = async (name) => {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  verify(true, name);
};
const openLatestReader = async () => {
  await page.getByTestId("im-results").click(); await page.getByTestId("im-artifact").last().click();
  await expect(page.getByTestId("personal-reader")).toBeVisible();
  return page.getByTestId("personal-reader");
};
const closeReader = async () => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("personal-modal")).toHaveCount(0);
};
const exportArtifact = async (artifact) => {
  await page.getByTestId("personal-reader-download").click();
  await expect(page.getByTestId("personal-save-receipt")).toContainText("已保存");
  const file = join(exportsDirectory, `${artifact.id}.md`);
  let bytes;
  await expect.poll(async () => {
    try { bytes = await readFile(file); return digest(bytes); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }).toBe(artifact.sha256);
  metadata.exports.push({ artifactId: artifact.id, file, bytes: bytes.byteLength, sha256: digest(bytes), expectedSha256: artifact.sha256, matches: true });
  verify(true, "native export bytes match saved artifact SHA-256");
};
const menuClick = (label) => application.evaluate(({ Menu, BrowserWindow }, label) => {
  const find = (menu) => {
    for (const item of menu.items) {
      if (item.label === label) return item;
      if (item.submenu) { const found = find(item.submenu); if (found) return found; }
    }
    return null;
  };
  const item = find(Menu.getApplicationMenu());
  if (!item) throw new Error(`Missing native menu ${label}`);
  item.click(item, BrowserWindow.getAllWindows()[0]);
  return { label: item.label, accelerator: item.accelerator };
}, label);
const sendThroughUI = async (text) => {
  await page.getByTestId("im-message-input").fill(text);
  await page.getByTestId("im-send").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("thread")).toMatch(/^thr_/);
  return new URL(page.url()).searchParams.get("thread");
};

const longSource = [
  "# 合成中文长文验收", "", "> 纯合成资料；本地统计与原文整理不是 AI 判断，也不代表真实业务记录。", "",
  "**结论：**中文标点后的强调应保留。", "", "~~旧结论。~~新的内容。", "",
  ...Array.from({ length: 18 }, (_, i) => [
    `## 第 ${i + 1} 节：持续阅读与返回`, "",
    "这是一段合成的中文长文，用于检查 macOS 窗口里的持续阅读。离开一件事再回来时，来源、草稿与报告应保留各自的位置。中英混排 AgentRoom、数字 2026.11 和标点只作为排版样本，不构成业务判断。".repeat(2), "",
  ].join("\n")),
  "## 宽表格", "",
  `| ${Array.from({ length: 12 }, (_, i) => `合成资料列 ${i + 1}`).join(" | ")} |`,
  `| ${Array(12).fill("---").join(" | ")} |`,
  `| ${Array.from({ length: 12 }, (_, i) => `需要完整阅读的第${i + 1}项内容`).join(" | ")} |`, "",
  "## 长代码行", "", "```js", `const syntheticLongLine = "${"abcdef0123456789".repeat(60)}";`, "```", "",
  "最后一行：NATIVE-SYNTHETIC-LONG-SOURCE-END", "",
].join("\n");

try {
  application = await launchDesktopTest(_electron, { executablePath: executable,
    args: packagedApp ? [] : [join(root, "apps/desktop")], env, timeout: 30_000 });
  page = await application.firstWindow();
  await page.getByTestId("im-app").waitFor();

  page.on("pageerror", (error) => metadata.rendererErrors.push(error.message));
  await expect(page.getByTestId("im-app")).toBeVisible();
  await expect(page.getByTestId("im-rail")).toBeVisible();
  metadata.url = page.url();
  metadata.bridge = await page.evaluate(() => ({ keys: Object.keys(window.agentStudioPersonal).sort(),
    legacyExposed: Boolean(window.agentStudioDesktop), hasRequire: typeof require !== "undefined",
    hasProcess: typeof process !== "undefined", platform: window.agentStudioPersonal.platform }));
  verify(metadata.url.startsWith("file://") && !metadata.bridge.legacyExposed && !metadata.bridge.hasRequire && !metadata.bridge.hasProcess,
    "bundled personal renderer exposes only its narrow preload; no Node or legacy bridge");
  metadata.health = await request("/health");
  const initial = await request("/bootstrap");
  verify(initial.threads.filter(thread => thread.id !== initial.workspace?.guide?.threadId).length === 0 && initial.connections.length === 0 && initial.memories.length === 0,
    "mkdtemp profile starts empty without accounts or inherited work");
  verify(initial.settings.codexAvailable === false, "synthetic missing CLI prevents model execution");
  verify(Boolean(metadata.health.desktopRuntime?.node && metadata.health.desktopRuntime?.sqlite), "native utility reports its Node and SQLite runtime");
  metadata.window = await application.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0], preferences = window.webContents.getLastWebPreferences();
    return { id: window.id, visible: window.isVisible(), bounds: window.getBounds(), minimumSize: window.getMinimumSize(),
      trafficLights: window.getWindowButtonPosition(), packaged: app.isPackaged,
      preferences: { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, preload: preferences.preload } };
  });
  verify(metadata.window.preferences.sandbox && metadata.window.preferences.contextIsolation && !metadata.window.preferences.nodeIntegration,
    "native window keeps sandbox and context isolation");
  if (packagedApp) verify(metadata.window.packaged, "AgentRoom.app runs as a packaged application without source arguments");
  metadata.utility = await recordUtility();
  verify(metadata.utility.length === 1, "exactly one owned personal utility is running");
  await page.evaluate(() => {
    window.__nativeSmokePolicyViolation = null;
    document.addEventListener("securitypolicyviolation", (event) => { window.__nativeSmokePolicyViolation = event.violatedDirective; }, { once: true });
    void fetch("http://127.0.0.1:18740/api/health").catch(() => {});
  });
  await expect.poll(() => page.evaluate(() => window.__nativeSmokePolicyViolation)).toBe("connect-src");
  metadata.csp = "connect-src";
  verify(true, "renderer direct HTTP is blocked by CSP; requests use the owned utility bridge");
  await capture("native-first-boot");

  await page.getByTestId("im-new").click(); await page.getByTestId("im-new-notes").click();
  await page.getByTestId("im-attach").setInputFiles({ name: "reading-notes.md", mimeType: "text/markdown", buffer: Buffer.from("# 20 分钟阅读安排\n\n合成验收资料。准备2分钟，阅读16分钟，记录2分钟。") });
  await sendThroughUI("整理这份合成阅读安排。");
  const sampleId = new URL(page.url()).searchParams.get("thread");
  const sample = await waitCompleted(sampleId);
  metadata.local = { threadId: sampleId, status: sample.status, artifacts: sample.artifacts };
  let reader = await openLatestReader();
  await expect(reader).toContainText("20 分钟阅读安排");
  await exportArtifact(sample.artifacts[0]);
  await capture("native-report-light");
  await closeReader();

  await page.getByTestId("im-new").click(); await page.getByTestId("im-new-notes").click();
  await page.getByTestId("im-send-options-toggle").click();
  await page.getByTestId("im-task-mode").selectOption("local");
  const fixture = join(output, "synthetic-long-reading.md");
  await writeFile(fixture, longSource);
  await page.getByTestId("im-attach").setInputFiles(fixture);
  const longId = await sendThroughUI("只在本地整理这份合成中文资料，保留十八节原文、宽表格和长代码。此操作不是 AI 判断。");
  const longThread = await waitCompleted(longId);
  verify((await request(`/threads/${longId}`)).artifacts.length === 1, "first long source artifact is saved");
  const source = longThread.messages.flatMap((message) => message.attachments || [])[0];
  verify(source?.text === longSource, "UI upload preserves all eighteen synthetic Chinese sections and original bytes");
  reader = await openLatestReader();
  await expect(reader).toContainText("NATIVE-SYNTHETIC-LONG-SOURCE-END");
  await expect(reader.locator("strong").filter({ hasText: "结论：" })).toHaveCount(1);
  await expect(reader.locator("del").filter({ hasText: "旧结论。" })).toHaveCount(1);
  verify(await reader.locator("table").count() >= 2 && await reader.locator("pre code").count() >= 1,
    "long local report renders structured tables, code and CJK emphasis");
  const table = reader.locator(".table-scroll").last();
  const code = reader.locator("pre").last();
  await expect.poll(() => table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await table.focus(); await table.press("ArrowRight");
  await expect.poll(() => table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(() => code.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await code.focus(); await code.press("ArrowRight");
  await expect.poll(() => code.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  verify(true, "wide table and long code scroll locally with keyboard input");
  await reader.evaluate((element) => { element.scrollTop = 1100; });
  await expect.poll(() => reader.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
  const savedPosition = await reader.evaluate((element) => element.scrollTop);
  await capture("native-long-reader-light");
  await closeReader();
  reader = await openLatestReader();
  await expect(reader).toContainText("NATIVE-SYNTHETIC-LONG-SOURCE-END");
  await expect.poll(() => reader.evaluate((element, target) => Math.abs(element.scrollTop - target), savedPosition)).toBeLessThan(3);
  metadata.readingPosition = { saved: savedPosition, restored: await reader.evaluate((element) => element.scrollTop) };
  verify(true, "long report restores its saved reading position");
  await exportArtifact(longThread.artifacts[0]);
  await closeReader();

  // The saved attachment ID enters a second local request through the UI. The
  // deterministic report quotes that request, providing a real source link.
  await sendThroughUI(`继续本地整理，并核对[已保存的合成原文](#source-${source.id})。保留所有原文；不调用 AI 或第三方工具。`);
  const linkedThread = await waitCompleted(longId, 2);
  verify((await request(`/threads/${longId}`)).artifacts.length === 2, "both long source artifact versions are saved");
  reader = await openLatestReader();
  await expect(reader).toContainText("NATIVE-SYNTHETIC-LONG-SOURCE-END");
  await reader.locator(`a[href="#source-${source.id}"]`).first().click();
  await expect(page.getByTestId("personal-modal")).toHaveCount(3);
  await expect(page.getByTestId("personal-modal").last()).toContainText("NATIVE-SYNTHETIC-LONG-SOURCE-END");
  await capture("native-long-source-light");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("personal-modal")).toHaveCount(2);
  await expect(reader).toBeVisible();
  verify(true, "first Escape closes only the source and retains the report");
  await closeReader();
  await expect(page.getByTestId("im-results")).toBeFocused();
  verify(true, "second Escape closes the report and restores its trigger focus");
  metadata.longReading = { threadId: longId, sourceBytes: Buffer.byteLength(longSource), sourceSha256: digest(longSource),
    sections: 18, artifacts: linkedThread.artifacts };

  await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = "dark"; });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
  metadata.nativeDark = await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  verify(metadata.nativeDark, "native and renderer dark modes are active");
  await capture("native-dark");
  reader = await openLatestReader();
  await expect(reader).toContainText("NATIVE-SYNTHETIC-LONG-SOURCE-END");
  await capture("native-reader-dark");
  await closeReader();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 760, height: 780 }));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(760);
  await noPageOverflow("760px conversation has no page overflow");
  await capture("native-760");
  reader = await openLatestReader();
  await expect(reader).toContainText("NATIVE-SYNTHETIC-LONG-SOURCE-END");
  await expect(page.getByTestId("personal-modal-close").last()).toBeInViewport();
  await noPageOverflow("760px dark long reader has no page overflow");
  await capture("native-reader-dark-760");
  await closeReader();

  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ width: 1200, height: 780 }); window.webContents.setZoomFactor(2);
  });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(600);
  metadata.zoomFactor = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  verify(metadata.zoomFactor === 2, "200% uses actual Electron webContents zoom, not viewport emulation");
  await expect(page.getByTestId("im-back")).toBeVisible();
  await capture("native-zoom-200");
  await page.getByTestId("im-back").click();
  await expect(page.getByTestId("im-list-panel")).toBeInViewport();
  metadata.zoom200 = await page.getByTestId("im-list-panel").evaluate((element) => ({ sidebarAccessible: !element.inert, cssWidth: innerWidth }));
  verify(metadata.zoom200.sidebarAccessible, "sidebar remains accessible at native 200% zoom");
  await noPageOverflow("native 200% sidebar has no page overflow");
  await capture("native-zoom-200-sidebar");
  await page.getByTestId(`im-chat-${longId}`).click();
  reader = await openLatestReader();
  await expect(reader).toContainText("NATIVE-SYNTHETIC-LONG-SOURCE-END");
  await expect(page.getByTestId("personal-modal-close").last()).toBeInViewport();
  await noPageOverflow("native 200% dark reader keeps its close control and local overflow");
  await capture("native-reader-dark-zoom-200");
  await closeReader();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1200);

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  metadata.hidden = true;
  const hidden = await request("/threads", { text: "Synthetic local organization while the native window is hidden; not AI.", mode: "local", clientId: "native-hidden-synthetic-local-task" });
  const hiddenDone = await waitCompleted(hidden.id);
  metadata.backgroundContinued = hiddenDone.status === "completed";
  await application.evaluate(({ app }) => app.emit("activate"));
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(process.env.AGENTROOM_AUTOMATION_VISIBLE === "1");
  metadata.reopened = await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().length === 1 && BrowserWindow.getAllWindows()[0].id === id, metadata.window.id);
  verify(metadata.reopened && metadata.backgroundContinued, "close hides the same native window while its local utility continues");
  metadata.menuCommands = {};
  metadata.menuCommands.search = await menuClick("搜索");
  await expect(page.getByTestId("im-search")).toBeFocused();
  metadata.menuCommands.settings = await menuClick("设置…");
  await expect(page.getByTestId("personal-modal")).toBeVisible();
  await page.getByTestId("personal-modal-close").click();
  metadata.menuCommands.new = await menuClick("新聊天");
  await expect(page.getByTestId("im-new-notes")).toBeVisible();
  await page.getByTestId("im-new-notes").click();
  await expect(page.getByTestId("im-message-input")).toBeFocused();
  verify(true, "native search, settings and new-chat menu commands reach the personal UI");
  const final = await request("/bootstrap");
  verify(final.connections.length === 0, "smoke never connects a real remote service");
  for (const thread of final.threads) {
    const saved = await request(`/threads/${thread.id}`);
    verify(saved.runs.every((run) => run.mode === "local" && (!run.chosenExecutor || run.chosenExecutor === "local")), "final persisted run audit contains only local organization");
  }
  await recordUtility();
  await application.close(); application = undefined;
  await expect.poll(() => [...utilityPids].every((pid) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code === "ESRCH") return true; throw error; }
  }), { timeout: 15_000, intervals: [100, 250, 500] }).toBe(true);
  metadata.utilityStopped = true;
  verify(metadata.rendererErrors.length === 0, "no renderer exceptions and owned utility stops on app quit");
  metadata.passed = true;
} catch (error) {
  metadata.passed = false;
  metadata.error = { name: error.name, message: error.message };
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, "failure-renderer.png") }).catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (application) {
    try { await application.close(); }
    catch (error) { metadata.cleanupError = error.message; process.exitCode = 1; }
  }
  await writeFile(join(output, "native-smoke.json"), JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify({ passed: metadata.passed, evidence: output, checks: metadata.checks.length,
    rendererErrors: metadata.rendererErrors.length, utilityStopped: metadata.utilityStopped || false,
    captureFallbacks: metadata.captures.filter((entry) => entry.fallback).length, localOrganizationIsAI: false }));
}
