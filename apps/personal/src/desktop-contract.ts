// Pure types shared by the bundled renderer and its narrow Electron preload.
// Credentials, filesystem APIs and arbitrary network destinations are not exposed.
export type DesktopCommand = "new" | "search" | "settings";
export type DesktopMethod = "GET" | "POST" | "DELETE";
export type PersonalServiceId = "grokbot" | "muse" | "dots" | "cue";
export type NativeIntegrationRequest =
  | { kind: "services" }
  | { kind: "connect"; serviceId: PersonalServiceId }
  | { kind: "progress" | "cancel"; flowId: string }
  | { kind: "choose"; flowId: string; choiceId: string }
  | { kind: "submit"; flowId: string; value: string }
  | { kind: "open" | "remove" | "reconnect"; instanceId: string }
  | { kind: "local-login"; agentId: "codex" | "claude" }
  | { kind: "local-login-status" | "local-login-cancel"; flowId: string };
export type NativeIntegrationReply = {
  state: "catalog" | "waiting" | "choose" | "input" | "ready" | "failed" | "cancelled";
  flowId?: string;
  expiresAt?: string;
  message?: string;
  providers?: { id: PersonalServiceId; name: string; description: string }[];
  instances?: { id?: string; instanceId?: string; service?: PersonalServiceId; name: string; status?: string; canOpen?: boolean; hasCredentials?: boolean; connectionId?: string; avatarDataUrl?: string }[];
  connectionIds?: string[];
  actions?: { id: string; label: string }[];
  choices?: { id: string; label: string }[];
  label?: string;
  secret?: boolean;
  error?: string;
  link?: { label: string; url: string };
};
export interface PersonalDesktopBridge {
  readonly platform: string;
  readonly version: string;
  readonly testMode?: boolean;
  chooseProject?(): Promise<{ cancelled: boolean }>;
  copyDeviceInvitation?(): Promise<void>;
  copyPlayInvitation?(input: { roomId: string; local: boolean }): Promise<void>;
  testWorkspace?(action: "enter" | "reset" | "leave"): Promise<{ restarting: boolean }>;
  request(input: {
    path: string;
    method: DesktopMethod;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }>;
  onChanged(listener: () => void): () => void;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
  saveArtifact(id: string): Promise<{
    cancelled: boolean;
    fileName?: string;
    path?: string;
    sha256?: string;
  }>;
  artifactAction?(input: { kind: "reveal" | "export"; artifactId: string; revisionId?: string }): Promise<{ cancelled: boolean; path?: string }>;
  restart(): Promise<void>;
  nativeIntegration?(request: NativeIntegrationRequest): Promise<NativeIntegrationReply>;
}
