// Electron main process for AgentRoom Desktop (macOS first).
//
// Security: the renderer runs with contextIsolation, sandbox and no Node
// integration; it reaches the OS only through the preload's narrow API. The
// renderer is bundled locally and served from file:// (dev: the Vite server).
// A strict CSP limits network access to the configured server origin.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BrowserWindow,
  clipboard,
  app,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
  utilityProcess,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { buildCsp, isExternalUrlAllowed, normalizeServerUrl, resolveServerUrl } from "../shared/config";
import { IPC, type DesktopInfo } from "../shared/desktop-api";
import { isAgentNotifyMode } from "../shared/notifications";
import { DesktopNotifier } from "./notifications";
import { DesktopStorage } from "./storage";
import { ConnectorManager, connectorsEnvFromProcess } from "./connectors/manager";
import { buildDiagnostics, writeDiagnostics } from "./diagnostics";
import appIcon from "../../resources/icon.png?asset";
import { PersonalHost } from "./personal-host";
import { PersonalServices } from "./personal-services";
import { LocalLoginHost, localExecutionEnv } from "./local-login";
import { resolveWorkspaceProfile, testWorkspaceArgs, type TestWorkspaceAction } from "./workspace-profile";
import { resolveAutomation } from "./automation";
import type { NativeIntegrationReply } from "@agentstudio/personal/desktop-contract";
import { PERSONAL_IPC, isTrustedDocument, personalCsp, readNativeIntegration, type PersonalCommand } from "../shared/personal-api";
import { ArtifactPreviewChecker } from "./artifact-preview-check";
import { artifactFileAction, readArtifactFileAction } from "./artifact-files";
import { artifactPreviewResponse } from "./artifact-preview";

declare const __APP_VERSION__: string;
declare const __APP_REVISION__: string;

protocol.registerSchemesAsPrivileged([{ scheme: "agentroom-artifact", privileges: { standard: true, secure: true, supportFetchAPI: false, allowServiceWorkers: false } }]);

// ---- profile isolation (must happen before "ready") ----------------------------

const workspaceProfile = resolveWorkspaceProfile(app.getPath("appData"), process.env, process.argv.slice(1));
const automation = resolveAutomation(process.env, __APP_REVISION__);
if (automation.enabled && !automation.visible && process.platform === "darwin") app.setActivationPolicy("accessory");
const userDataDir = process.env.AGENTROOM_USER_DATA_DIR || process.env.AGENTSTUDIO_USER_DATA_DIR;
mkdirSync(workspaceProfile.userData, { recursive: true, mode: 0o700 });
app.setPath("userData", workspaceProfile.userData);
app.setPath("sessionData", workspaceProfile.userData);
// Tests can avoid touching the real login keychain (safeStorage then uses a mock key).
if (process.env.AGENTSTUDIO_MOCK_KEYCHAIN === "1") app.commandLine.appendSwitch("use-mock-keychain");

// Keep the existing keychain identity; all visible product names are AgentRoom.
app.setName("AgentStudio");

const personalMode = workspaceProfile.testMode || process.env.AGENTSTUDIO_WORKSPACE !== "matrix";
const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererHtml = join(__dirname, personalMode ? "../renderer/personal/index.html" : "../renderer/index.html");
const rendererFileUrl = pathToFileURL(rendererHtml).href;
const rendererDocumentUrl = devServerUrl ? new URL(personalMode ? "personal/index.html" : "index.html", `${devServerUrl.replace(/\/+$/, "")}/`).href : rendererFileUrl;

let storage: DesktopStorage;
let connectors: ConnectorManager;
let notifier: DesktopNotifier;
let mainWindow: BrowserWindow | null = null;
let windowShown = false;
let quitting = false;
let personalHost: PersonalHost | undefined;
let personalServices: PersonalServices | undefined;
let localLogin: LocalLoginHost | undefined;
let artifactPreviewChecker: ArtifactPreviewChecker | undefined;
let personalStartup = Promise.resolve();
let personalStartupFailed = false;
const nativeConnections = new Map<string, string>();
const nativeRegistrations = new Map<string, Promise<string>>();
const nativeInstanceRegistration = new Map<string, Promise<string>>();
// Keep the original idempotent registration until removal is confirmed. A lost
// POST receipt must be recovered before deleting its provider instance.
const nativeRegistrationInputs = new Map<string, { instanceId: string; name: string; url: string; token: string }>();
const nativeRemovals = new Set<string>();
let shutdownPromise: Promise<void> | undefined;
let shutdownComplete = false;
let switchingWorkspace = false;
let nativeOperations = 0;

function serverUrl(): string {
  return resolveServerUrl(process.env.AGENTSTUDIO_SERVER_URL, storage.readSettings().serverUrl);
}

/** Only our own renderer document may use the IPC API. */
function fromRenderer(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !personalMode && fromOwnFrame(e);
}

function fromOwnFrame(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !quitting && !!mainWindow && e.sender === mainWindow.webContents && e.senderFrame === mainWindow.webContents.mainFrame &&
    isTrustedDocument(e.senderFrame.url, rendererDocumentUrl);
}

function fromPersonal(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return personalMode && fromOwnFrame(e);
}

function isOwnUrl(url: string): boolean {
  return isTrustedDocument(url, rendererDocumentUrl);
}

function documentCsp(): string { return personalMode ? personalCsp(devServerUrl) : buildCsp(serverUrl(), devServerUrl); }

// ---- CSP ---------------------------------------------------------------------------

function installCsp() {
  protocol.handle("agentroom-artifact", request => {
    if (!personalMode || !personalHost || switchingWorkspace || request.method !== "GET") return new Response("Preview unavailable", { status: 404 });
    return artifactPreviewResponse(request.url, input => personalHost!.request(input));
  });
  if (devServerUrl) {
    // Dev: the renderer comes from the Vite server over http; add the header there.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      if (isOwnUrl(details.url) && details.resourceType === "mainFrame") {
        headers["Content-Security-Policy"] = [documentCsp()];
      }
      callback({ responseHeaders: headers });
    });
    return;
  }
  // Production: intercept file:// so the HTML document carries a CSP header.
  // Only files inside the bundled renderer directory are served.
  const rendererDir = resolve(__dirname, "../renderer");
  protocol.handle("file", async (request) => {
    let filename: string;
    try { filename = resolve(fileURLToPath(request.url)); } catch { return new Response("Not found", { status: 404 }); }
    if (!filename.startsWith(`${rendererDir}${sep}`)) return new Response("Not found", { status: 404 });
    const res = await net.fetch(request, { bypassCustomProtocolHandlers: true });
    const headers = new Headers(res.headers);
    if (request.url.split(/[?#]/)[0]!.endsWith(".html")) {
      headers.set("Content-Security-Policy", documentCsp());
      headers.set("Content-Type", "text/html; charset=utf-8");
    }
    return new Response(res.body, { status: res.status, headers });
  });
}

// ---- window -------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: automation.title || (workspaceProfile.testMode ? "AgentRoom · 测试模式" : "AgentRoom"),
    ...(automation.enabled && !automation.visible ? { focusable: false, skipTaskbar: true } : {}),
    icon: appIcon, // Windows and Linux; macOS uses the Dock icon below
    titleBarStyle: "hiddenInset",
    trafficLightPosition: personalMode ? { x: 18, y: 14 } : { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f5f5f7",
    ...(personalMode && process.platform === "darwin" ? {
      vibrancy: "sidebar" as const,
      visualEffectState: "followWindow" as const,
      backgroundColor: "#00000000",
    } : {}),
    webPreferences: {
      preload: join(__dirname, personalMode ? "../preload/personal.js" : "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      ...(automation.enabled ? { backgroundThrottling: false } : {}),
    },
  });
  mainWindow = win;
  if (automation.title) win.on("page-title-updated", event => { event.preventDefault(); win.setTitle(automation.title!); });
  if (workspaceProfile.testMode && !automation.enabled) win.on("page-title-updated", event => { event.preventDefault(); win.setTitle("AgentRoom · 测试模式"); });

  windowShown = false;
  win.once("ready-to-show", () => {
    windowShown = true;
    if (automation.visible) win.show();
  });
  // On macOS closing the window only hides it: the app keeps syncing in the
  // background, so notifications and the Dock badge keep working.
  win.on("close", (e) => {
    if (process.platform !== "darwin" || quitting) return;
    e.preventDefault();
    // A full-screen window would leave an empty Space behind; leave full screen first.
    if (win.isFullScreen()) {
      win.once("leave-full-screen", () => win.hide());
      win.setFullScreen(false);
    } else win.hide();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // No in-app popups: external links go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (automation.visible && isExternalUrlAllowed(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (isOwnUrl(url)) return;
    e.preventDefault();
    if (automation.visible && isExternalUrlAllowed(url)) void shell.openExternal(url);
  });
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());

  if (devServerUrl) void win.loadURL(rendererDocumentUrl);
  else void win.loadFile(rendererHtml);
}

function focusWindow() {
  if (!automation.visible) return;
  if (!mainWindow) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

// ---- IPC ----------------------------------------------------------------------------

function registerIpc() {
  ipcMain.on(IPC.info, (e) => {
    if (!fromRenderer(e)) {
      e.returnValue = null;
      return;
    }
    const info: DesktopInfo = {
      version: __APP_VERSION__,
      platform: process.platform,
      serverUrl: serverUrl(),
      serverUrlFromEnv: !!process.env.AGENTSTUDIO_SERVER_URL,
      emailSignInOnly: process.env.AGENTSTUDIO_EMAIL_SIGNIN === "1",
    };
    e.returnValue = info;
  });

  ipcMain.handle(IPC.setServerUrl, (e, url: unknown) => {
    if (!fromRenderer(e) || typeof url !== "string") throw new Error("forbidden");
    const normalized = normalizeServerUrl(url);
    storage.writeSettings({ ...storage.readSettings(), serverUrl: normalized });
    // The CSP is computed per document load, so reload to apply the new origin.
    setTimeout(() => mainWindow?.webContents.reload(), 50);
  });

  ipcMain.handle(IPC.sessionLoad, (e) => {
    if (!fromRenderer(e)) throw new Error("forbidden");
    return storage.loadSession();
  });
  ipcMain.handle(IPC.sessionSave, (e, s: unknown) => {
    if (!fromRenderer(e) || !s || typeof s !== "object") throw new Error("forbidden");
    storage.saveSession(s);
  });
  ipcMain.handle(IPC.sessionClear, (e) => {
    if (!fromRenderer(e)) throw new Error("forbidden");
    storage.clearSession();
  });

  ipcMain.on(IPC.notify, (e, input: unknown) => {
    if (fromRenderer(e)) notifier.show(input);
  });
  ipcMain.on(IPC.badge, (e, count: unknown) => {
    if (fromRenderer(e)) notifier.setBadge(count);
  });
  ipcMain.handle(IPC.notifyTakeClick, (e) => (fromRenderer(e) ? notifier.takeClick() : null));
  ipcMain.handle(IPC.notifyPrefs, async (e, op: unknown, a?: unknown, b?: unknown) => {
    if (!fromRenderer(e)) throw new Error("forbidden");
    switch (op) {
      case "get":
        return notifier.prefs();
      case "enabled":
        if (typeof a !== "boolean") throw new Error("bad argument");
        return notifier.setEnabled(a);
      case "agent":
        if (typeof a !== "string" || !a || a.length > 200 || !isAgentNotifyMode(b)) throw new Error("bad argument");
        return notifier.setAgentMode(a, b);
      case "system-settings":
        return notifier.openSystemSettings();
    }
    throw new Error("unknown operation");
  });

  ipcMain.handle(IPC.exportDiagnostics, async (e) => {
    if (!fromRenderer(e)) throw new Error("forbidden");
    const text = buildDiagnostics({ userData: app.getPath("userData"), appVersion: __APP_VERSION__, connectors: connectors?.list() ?? [] });
    const name = `agentstudio-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    // Tests write straight to a folder instead of asking.
    const testDir = process.env.AGENTSTUDIO_TEST_DIAGNOSTICS_DIR;
    let file: string | undefined;
    if (testDir) file = join(testDir, name);
    else {
      const res = await dialog.showSaveDialog({ defaultPath: join(app.getPath("downloads"), name), filters: [{ name: "JSON", extensions: ["json"] }] });
      file = res.canceled ? undefined : res.filePath;
    }
    if (!file) return null;
    writeDiagnostics(file, text);
    return file;
  });

  ipcMain.handle(IPC.openExternal, async (e, url: unknown) => {
    if (!fromRenderer(e) || typeof url !== "string" || !isExternalUrlAllowed(url)) throw new Error("forbidden");
    if (automation.visible) await shell.openExternal(url);
  });

  ipcMain.handle(IPC.connectors, async (e, op: unknown, a?: unknown, b?: unknown) => {
    if (!fromRenderer(e)) throw new Error("forbidden");
    const str = (v: unknown) => {
      if (typeof v !== "string" || v.length > 200) throw new Error("bad argument");
      return v;
    };
    switch (op) {
      case "services":
        return connectors.services();
      case "list":
        return connectors.list();
      case "begin": {
        const service = str(a);
        if (service !== "grokbot" && service !== "muse" && service !== "dots" && service !== "cue") throw new Error("unknown service");
        return connectors.begin(service);
      }
      case "progress":
        return connectors.progress(str(a));
      case "choose":
        return connectors.choose(str(a), str(b));
      case "submit": {
        if (typeof b !== "string" || b.length > 1000) throw new Error("bad argument");
        return connectors.submit(str(a), b);
      }
      case "cancel":
        return connectors.cancel(str(a));
      case "remove":
        return connectors.remove(str(a));
      case "open":
        return connectors.open(str(a));
      case "attach":
        return connectors.attach(str(a), str(b));
    }
    throw new Error("unknown operation");
  });
}

function registerPersonalIpc() {
  ipcMain.handle(PERSONAL_IPC.chooseProject, async event => {
    if (!fromPersonal(event) || !personalHost || switchingWorkspace || quitting) throw new Error("forbidden");
    nativeOperations++;
    try {
      const result = await dialog.showOpenDialog(mainWindow!, { title: "选择阿屋可以读取的项目目录", properties: ["openDirectory"] });
      if (result.canceled || !result.filePaths[0]) return { cancelled: true };
      const reply = await personalHost.registerProject(result.filePaths[0]);
      if (reply.status >= 400) throw new Error((reply.body as { error?: { message?: string } })?.error?.message || "项目目录尚未保存");
      return { cancelled: false };
    } finally { nativeOperations--; }
  });
  ipcMain.on(PERSONAL_IPC.info, (event) => {
    event.returnValue = fromPersonal(event) ? { platform: process.platform, version: __APP_VERSION__, testMode: workspaceProfile.testMode } : null;
  });
  ipcMain.handle(PERSONAL_IPC.request, async (event, input: unknown) => {
    if (!fromPersonal(event) || !personalHost || switchingWorkspace) throw new Error("forbidden");
    await personalStartup;
    if (personalStartupFailed) return { status: 503, body: { error: { code: "native_restore_failed", message: "已保存的个人服务尚未恢复，任务已保留且没有再次发送。请重新启动后台重试。" } } };
    return personalHost.request(input as Parameters<PersonalHost["request"]>[0]);
  });
  ipcMain.handle(PERSONAL_IPC.saveArtifact, (event, id: unknown) => {
    if (!fromPersonal(event) || !personalHost || typeof id !== "string") throw new Error("forbidden");
    return personalHost.saveArtifact(id);
  });
  ipcMain.handle(PERSONAL_IPC.artifactAction, async (event, input: unknown) => {
    if (!fromPersonal(event) || !personalHost || switchingWorkspace) throw new Error("forbidden");
    const action = readArtifactFileAction(input); nativeOperations++;
    try {
      return await artifactFileAction(action, { dataDir: workspaceProfile.personalData, request: input => personalHost!.request(input),
        reveal: path => shell.showItemInFolder(path), chooseDirectory: async () => {
          const result = await dialog.showOpenDialog(mainWindow!, { title: "导出所选作品版本", properties: ["openDirectory", "createDirectory"] });
          return result.canceled ? null : result.filePaths[0] || null;
        } });
    } finally { nativeOperations--; }
  });
  ipcMain.handle(PERSONAL_IPC.copyDeviceInvitation, async event => {
    if (!fromPersonal(event) || !personalHost || switchingWorkspace || quitting) throw new Error("forbidden");
    nativeOperations++;
    try {
      const response = await personalHost.request({ path: "/api/sharing/invite", method: "POST", body: {} });
      const invitation = response.body as { url?: string; token?: string };
      if (switchingWorkspace || quitting || !fromPersonal(event) || response.status !== 200 || typeof invitation?.url !== "string" || typeof invitation.token !== "string") throw new Error("连接信息暂时不可用");
      clipboard.writeText(JSON.stringify({ url: invitation.url, token: invitation.token }));
    } finally { nativeOperations--; }
  });
  ipcMain.handle(PERSONAL_IPC.copyPlayInvitation, async (event, input: unknown) => {
    if (!fromPersonal(event) || !personalHost || switchingWorkspace || quitting || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("forbidden");
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !["roomId", "local"].includes(key)) || typeof value.roomId !== "string" || !/^pr_[A-Za-z0-9_-]{1,150}$/.test(value.roomId) || typeof value.local !== "boolean") throw new Error("forbidden");
    nativeOperations++;
    try {
      const response = await personalHost.request({ path: `/api/playrooms/${value.roomId}/invite`, method: "POST", body: {} });
      const invitation = response.body as { roomId?: string; url?: string; localUrl?: string };
      const raw = value.local ? invitation.localUrl : invitation.url;
      if (switchingWorkspace || quitting || !fromPersonal(event) || response.status !== 200 || invitation.roomId !== value.roomId || typeof raw !== "string") throw new Error("邀请暂时不可用，请重新打开房间");
      const url = new URL(raw);
      if (url.username || url.password || url.search || url.pathname !== `/g/${value.roomId}` || !/^#[A-Za-z0-9_-]{43}$/.test(url.hash) || (value.local ? url.protocol !== "http:" || url.hostname !== "127.0.0.1" : url.protocol !== "https:")) throw new Error("邀请地址不符合当前房间");
      clipboard.writeText(raw);
    } finally { nativeOperations--; }
  });
  ipcMain.handle(PERSONAL_IPC.restart, async (event) => {
    if (!fromPersonal(event) || !personalHost || switchingWorkspace) throw new Error("forbidden");
    if (personalStartupFailed) {
      await personalServices?.restore();
      personalStartupFailed = false;
    }
    await personalHost.restart();
  });
  ipcMain.handle(PERSONAL_IPC.testWorkspace, async (event, action: unknown) => {
    if (!fromPersonal(event)) throw new Error("forbidden");
    return switchTestWorkspace(action);
  });
  ipcMain.handle(PERSONAL_IPC.integration, async (event, input: unknown): Promise<NativeIntegrationReply> => {
    if (!fromPersonal(event) || !personalServices || !personalHost || !localLogin || switchingWorkspace) throw new Error("forbidden");
    const action = readNativeIntegration(input);
    nativeOperations++;
    try {
      await personalStartup;
      if (quitting || switchingWorkspace || !fromPersonal(event)) return { state: "failed", message: "应用正在退出或切换，没有开始新的连接。" };
      if (action.kind === "local-login") return localLogin.begin(action.agentId);
      if (action.kind === "local-login-status") return localLogin.status(action.flowId);
      if (action.kind === "local-login-cancel") return localLogin.cancel(action.flowId);
      if (action.kind === "services") {
        const instances = await personalServices.list();
        const saved = await personalHost.syncNativeServices(await personalServices.snapshot(instances));
        const live = instances.map(instance => ({ id: instance.id, service: instance.service, name: instance.name, status: instance.status,
          canOpen: instance.canOpen, avatarDataUrl: instance.avatarDataUrl, hasCredentials: true, connectionId: nativeConnections.get(instance.id) }));
        return { state: "catalog", providers: personalServices.services(), instances: [
          ...live, ...(saved || []).filter(instance => !live.some(item => item.id === instance.id)),
        ] };
      }
      if (action.kind === "connect") return { state: "waiting", flowId: await personalServices.begin(action.serviceId), message: "请按提示完成你自己的账号登录" };
      if (action.kind === "progress") {
        const progress = await personalServices.progress(action.flowId);
        if (progress.state === "ready") {
          const connectionIds = [];
          const instances = progress.instances.length ? progress.instances : await personalServices.registrations();
          for (const instance of instances) connectionIds.push(await registerNativeInstance(instance));
          if (instances.some(instance => nativeRemovals.has(instance.instanceId))) return { state: "failed", flowId: action.flowId, message: "这项连接正在断开，没有重新启用。" };
          return { state: "ready", flowId: action.flowId, instances: progress.instances.map(instance => ({ instanceId: instance.instanceId, name: instance.name })), connectionIds };
        }
        return { ...await personalServices.publicProgress(action.flowId), flowId: action.flowId };
      }
      if (action.kind === "choose") await personalServices.choose(action.flowId, action.choiceId);
      if (action.kind === "submit") await personalServices.submit(action.flowId, action.value);
      if (action.kind === "cancel") {
        const latest = await personalServices.progress(action.flowId);
        if (latest.state === "ready") {
          const connectionIds = [];
          for (const instance of latest.instances) connectionIds.push(await registerNativeInstance(instance));
          return { state: "ready", flowId: action.flowId, message: "登录已经完成；你可以在已连接列表中断开。", connectionIds };
        }
        await personalServices.cancel(action.flowId); return { state: "cancelled", flowId: action.flowId };
      }
      if (action.kind === "open") {
        const instance = (await personalServices.list()).find(item => item.id === action.instanceId);
        if (!instance?.canOpen) return { state: "failed", message: "请到原服务的 App 中处理，再回来核查这件事；本机不会代你批准。" };
        await personalServices.open(action.instanceId); return { state: "ready" };
      }
      if (action.kind === "reconnect") {
        const instance = (await personalServices.registrations()).find(item => item.instanceId === action.instanceId);
        if (!instance) return { state: "failed", message: "登录记录已不存在，请重新连接这个账号。" };
        return { state: "ready", connectionIds: [await registerNativeInstance(instance)] };
      }
      if (action.kind === "remove") {
        nativeRemovals.add(action.instanceId);
        let removed = false;
        try {
          try { await nativeInstanceRegistration.get(action.instanceId); } catch { /* Recover the original receipt below. */ }
          let connectionId = nativeConnections.get(action.instanceId);
          const registration = nativeRegistrationInputs.get(action.instanceId);
          if (!connectionId && registration) connectionId = await registerNativeInstance(registration, true);
          if (connectionId) {
            const response = await personalHost.request({ path: `/api/connections/${connectionId}`, method: "DELETE" });
            if (response.status >= 300) return { state: "failed", message: "这项连接还有进行中或待核查的事情，请先处理原任务。" };
            nativeConnections.delete(action.instanceId);
          }
          await personalServices.remove(action.instanceId); removed = true; nativeConnections.delete(action.instanceId);
          nativeRegistrationInputs.delete(action.instanceId);
          mainWindow?.webContents.send(PERSONAL_IPC.changed, {}); return { state: "ready" };
        } finally { if (!removed) nativeRemovals.delete(action.instanceId); }
      }
      return { state: "waiting", ...("flowId" in action ? { flowId: action.flowId } : {}) };
    } catch {
      return { state: "failed", ...("flowId" in action ? { flowId: action.flowId } : {}), message: "连接暂时未完成。已有任务与登录信息保留，请重试或到原服务检查账号。" };
    } finally { nativeOperations--; }
  });
}

async function registerNativeInstance(instance: { instanceId: string; name: string; url: string; token: string; service?: string }, recoveringRemoval = false): Promise<string> {
  if ((nativeRemovals.has(instance.instanceId) && !recoveringRemoval) || quitting) throw new Error("Native instance is being removed");
  const registering = nativeInstanceRegistration.get(instance.instanceId);
  if (registering) return registering;
  const identity = createHash("sha256").update(JSON.stringify(instance)).digest("hex");
  nativeRegistrationInputs.set(instance.instanceId, { ...instance });
  const active = nativeRegistrations.get(identity);
  if (active) return active;
  const pending = (async () => {
    const response = await personalHost!.request({ path: "/api/connections", method: "POST", body: {
      name: instance.name, type: "a2a", url: instance.url, token: instance.token, clientId: `native-${identity}`,
    } });
    const connection = response.body as { id?: string };
    if (response.status >= 300 || !connection.id) throw new Error("Native registration failed");
    if (instance.service === "grokbot") await personalHost!.registerNativeSource({ connectionId: connection.id, instanceId: instance.instanceId, service: instance.service });
    nativeConnections.set(instance.instanceId, connection.id);
    mainWindow?.webContents.send(PERSONAL_IPC.changed, {});
    return connection.id;
  })();
  nativeRegistrations.set(identity, pending);
  nativeInstanceRegistration.set(instance.instanceId, pending);
  try { return await pending; } finally {
    nativeRegistrations.delete(identity);
    if (nativeInstanceRegistration.get(instance.instanceId) === pending) nativeInstanceRegistration.delete(instance.instanceId);
  }
}

function sendPersonalCommand(command: PersonalCommand) {
  if (!personalMode) return;
  focusWindow();
  mainWindow?.webContents.send(PERSONAL_IPC.command, command);
}

async function switchTestWorkspace(action: unknown) {
  if (!personalMode || !personalHost || !personalServices || !localLogin || switchingWorkspace || quitting) throw new Error("工作区尚未就绪，请稍后重试");
  if (action !== "enter" && action !== "reset" && action !== "leave") throw new Error("未知测试模式操作");
  if (action === "enter" ? workspaceProfile.testMode : !workspaceProfile.testMode) throw new Error("当前工作区不支持这项操作");
  // Reserve before showing a dialog, so repeated requests cannot schedule two relaunches.
  switchingWorkspace = true;
  try {
    await personalStartup;
    if (personalStartupFailed) throw new Error("个人服务尚未恢复，请先重新启动后台核查");
    if (nativeOperations || localLogin.hasPendingLogin() || personalServices.hasPendingLogin() || personalServices.hasUnresolvedTasks()) throw new Error("仍有登录、执行或待核查结果，请先处理后再切换");
    const options: Electron.MessageBoxOptions = {
      type: "question", title: "AgentRoom",
      message: action === "enter" ? "进入独立测试模式？" : action === "reset" ? "清空本轮测试并重新引导？" : "返回你的工作区？",
      detail: action === "leave" ? "会重新打开原工作区，当前测试资料保留。本机助手的 CLI 登录不会改变。" : "应用会重新打开一个空白测试工作区。原工作区不受影响；旧测试资料保留用于恢复。本机助手的 CLI 登录仍然沿用。",
      buttons: [action === "leave" ? "返回我的工作区" : action === "reset" ? "清空并重新引导" : "进入测试模式", "取消"], defaultId: 0, cancelId: 1, noLink: true,
    };
    const answer = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    if (answer.response !== 0) { switchingWorkspace = false; return { restarting: false }; }
    await personalHost.prepareWorkspaceSwitch();
    if (nativeOperations || localLogin.hasPendingLogin() || personalServices.hasPendingLogin() || personalServices.hasUnresolvedTasks()) {
      personalHost.cancelWorkspaceSwitch(); throw new Error("确认期间出现新的执行或登录，请先处理后再切换");
    }
    await personalHost.stop(true);
    await personalServices.stop();
    app.relaunch({ args: testWorkspaceArgs(process.argv.slice(1), action as TestWorkspaceAction, randomUUID()) });
    app.quit();
    return { restarting: true };
  } catch (error) { switchingWorkspace = false; throw error; }
}

function installMenu() {
  const personalItems: Electron.MenuItemConstructorOptions[] = personalMode ? [
    { label: "新聊天", accelerator: "CmdOrCtrl+N", click: () => sendPersonalCommand("new") },
    { label: "搜索", accelerator: "CmdOrCtrl+K", click: () => sendPersonalCommand("search") },
  ] : [];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "AgentRoom", submenu: [
      { role: "about", label: "关于 AgentRoom" },
      ...(personalMode ? [{ label: "设置…", accelerator: "CmdOrCtrl+,", click: () => sendPersonalCommand("settings") }, { type: "separator" as const }] : []),
      { role: "services" }, { type: "separator" }, { role: "hide", label: "隐藏 AgentRoom" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit", label: "退出 AgentRoom" },
    ] },
    { label: "文件", submenu: [...personalItems, ...(personalItems.length ? [{ type: "separator" as const }] : []), { role: "close" }] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "显示", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
  ]));
}

// ---- lifecycle ----------------------------------------------------------------------

const gotLock = userDataDir ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", focusWindow);
  // Sign-in callbacks (cuedev:// for Cue) come back as links.
  app.on("open-url", (e, url) => {
    e.preventDefault();
    if (connectors?.handleLink(url) || personalServices?.handleLink(url)) focusWindow();
  });
  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: "AgentRoom", applicationVersion: __APP_VERSION__, version: __APP_REVISION__ });
    // Run from source, the app is Electron's own bundle: give it AgentRoom's icon in the Dock.
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(appIcon);
    const dir = app.getPath("userData");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!personalMode) {
      storage = new DesktopStorage(dir);
      notifier = new DesktopNotifier(storage, () => {
        focusWindow(); mainWindow?.webContents.send(IPC.notifyClicked);
      });
      connectors = new ConnectorManager(connectorsEnvFromProcess(), dir);
    } else {
      personalServices = new PersonalServices({ userData: dir, env: connectorsEnvFromProcess(),
        onAvatarsChanged: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(PERSONAL_IPC.changed, {}); },
      });
      localLogin = new LocalLoginHost({ onChanged: () => { mainWindow?.webContents.send(PERSONAL_IPC.changed, {}); } });
      personalHost = new PersonalHost({
        dataDir: workspaceProfile.personalData,
        workerPath: join(__dirname, "personal/worker.mjs"), staticDir: join(__dirname, "../renderer/personal"),
        // Finder launches have a minimal PATH. Add ordinary installation paths
        // without sourcing shell startup files or changing the selected account.
        env: localExecutionEnv(),
        fork: (path, args, options) => utilityProcess.fork(path, args, options),
        processIdentity: (pid) => {
          const metric = app.getAppMetrics().find((entry) => entry.pid === pid && entry.type === "Utility" && entry.name === "AgentRoom Personal Runtime");
          return metric ? { pid: metric.pid, creationTime: metric.creationTime, type: metric.type, name: metric.name || "" } : null;
        },
        buildRef: process.env.PERSONAL_BUILD_REF || __APP_REVISION__, codexCommand: process.env.AGENTSTUDIO_CODEX_BIN,
        testExportDir: process.env.AGENTSTUDIO_PERSONAL_EXPORT_DIR,
        onChanged: (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(PERSONAL_IPC.changed, event); if (event.previewCheck) artifactPreviewChecker?.enqueue(event.previewCheck); },
        chooseSavePath: async (name) => {
          const options = { defaultPath: join(app.getPath("downloads"), name), filters: [{ name: "Markdown", extensions: ["md"] }] };
          const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
          return result.canceled ? null : result.filePath || null;
        },
      });
    }
    if (personalHost) artifactPreviewChecker = new ArtifactPreviewChecker(input => personalHost!.request(input), (target, checks) => personalHost!.reportArtifactPreview(target.workId, target.revisionId, checks));
    // Deny every permission request (camera, mic, geolocation, ...) except notifications.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(!personalMode && permission === "notifications"));
    installCsp();
    registerIpc();
    registerPersonalIpc(); installMenu();
    if (personalMode) personalStartup = (async () => {
      let restored = false;
      try { restored = await personalServices!.restore(); }
      catch { personalStartupFailed = true; return; }
      await personalHost?.start();
      if (restored) for (const instance of await personalServices!.registrations()) await registerNativeInstance(instance);
      if (restored) await personalHost!.syncNativeServices(await personalServices!.snapshot());
    })().catch(() => { /* request() exposes runtime errors without exposing provider diagnostics */ });
    else void connectors.start().catch(() => console.error("[agentstudio] connectors failed to start"));
    createWindow();
    app.on("activate", () => {
      if (!automation.visible) return;
      // Connector windows are hidden but count as windows; check ours. It may
      // be hidden after a close; before its first show, ready-to-show shows it.
      if (!mainWindow) createWindow();
      else if (windowShown && !mainWindow.isVisible()) mainWindow.show();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    quitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    if (!shutdownPromise) shutdownPromise = (async () => { artifactPreviewChecker?.close(); localLogin?.stop(); await personalHost?.stop(); await personalServices?.stop(); await connectors?.stop(); })()
      .finally(() => { shutdownComplete = true; app.quit(); });
  });
}
