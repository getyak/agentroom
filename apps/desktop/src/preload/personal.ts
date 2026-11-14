import { contextBridge, ipcRenderer } from "electron";
import { PERSONAL_IPC, type AgentStudioPersonal, type PersonalCommand } from "../shared/personal-api";

const info = ipcRenderer.sendSync(PERSONAL_IPC.info) as { platform: string; version: string; testMode: boolean } | null;
if (!info) throw new Error("Personal preload was loaded outside its trusted document");

const api: AgentStudioPersonal = {
  platform: info.platform,
  version: info.version,
  testMode: info.testMode,
  chooseProject: () => ipcRenderer.invoke(PERSONAL_IPC.chooseProject),
  testWorkspace: (action) => ipcRenderer.invoke(PERSONAL_IPC.testWorkspace, action),
  request: (input) => ipcRenderer.invoke(PERSONAL_IPC.request, input),
  saveArtifact: (id) => ipcRenderer.invoke(PERSONAL_IPC.saveArtifact, id),
  artifactAction: input => ipcRenderer.invoke(PERSONAL_IPC.artifactAction, input),
  copyDeviceInvitation: () => ipcRenderer.invoke(PERSONAL_IPC.copyDeviceInvitation),
  copyPlayInvitation: input => ipcRenderer.invoke(PERSONAL_IPC.copyPlayInvitation, input),
  restart: () => ipcRenderer.invoke(PERSONAL_IPC.restart),
  nativeIntegration: (request) => ipcRenderer.invoke(PERSONAL_IPC.integration, request),
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(PERSONAL_IPC.changed, listener);
    return () => ipcRenderer.removeListener(PERSONAL_IPC.changed, listener);
  },
  onCommand: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, command: PersonalCommand) => callback(command);
    ipcRenderer.on(PERSONAL_IPC.command, listener);
    return () => ipcRenderer.removeListener(PERSONAL_IPC.command, listener);
  },
};

contextBridge.exposeInMainWorld("agentStudioPersonal", api);
