import type { PersonalDesktopBridge, DesktopCommand } from "@agentstudio/personal/desktop-contract";
import type { NativeIntegrationRequest } from "@agentstudio/personal/desktop-contract";
export type { PersonalDesktopBridge as AgentStudioPersonal, DesktopMethod } from "@agentstudio/personal/desktop-contract";
export type PersonalCommand = DesktopCommand;
export type PersonalRequest = Parameters<PersonalDesktopBridge["request"]>[0];
export type PersonalResponse = Awaited<ReturnType<PersonalDesktopBridge["request"]>>;
export type PersonalChange = { threadId?: string; previewCheck?: { workId: string; artifactId: string; revisionId: string } };
export type PersonalSaveResult = Awaited<ReturnType<PersonalDesktopBridge["saveArtifact"]>>;

export const PERSONAL_IPC = {
  info: "agentstudio:personal:info",
  request: "agentstudio:personal:request",
  changed: "agentstudio:personal:changed",
  command: "agentstudio:personal:command",
  saveArtifact: "agentstudio:personal:save-artifact",
  artifactAction: "agentstudio:personal:artifact-action",
  restart: "agentstudio:personal:restart",
  copyDeviceInvitation: "agentstudio:personal:copy-device-invitation",
  copyPlayInvitation: "agentstudio:personal:copy-play-invitation",
  integration: "agentstudio:personal:integration",
  testWorkspace: "agentstudio:personal:test-workspace",
  chooseProject: "agentstudio:personal:choose-project",
} as const;

const opaqueId = "[A-Za-z0-9_-]{1,160}";
const routes: Record<PersonalRequest["method"], RegExp[]> = {
  GET: [
    /^\/api\/mcp\/access$/,
    /^\/api\/integrations\/nango\/recovery$/,
    /^\/api\/roomie$/,
    /^\/api\/group-rules$/,
    /^\/api\/play-network$/,
    new RegExp(`^/api/playrooms(?:/${opaqueId})?$`),
    new RegExp(`^/api/chats/${opaqueId}/(sharing|artifacts)$`),
    /^\/api\/sharing$/,
    /^\/api\/im\/settings$/,
    /^\/api\/library\/artifacts$/,
    new RegExp(`^/api/(collaborations|capability-requests)/${opaqueId}$`),
    new RegExp(`^/api/library/artifacts/${opaqueId}$`),
    new RegExp(`^/api/library/previews/${opaqueId}(?:/files/${opaqueId})?$`),
    new RegExp(`^/api/threads/${opaqueId}/creation$`),
    /^\/api\/workspace\/status$/,
    /^\/api\/(health|bootstrap|connections|memories)$/,
    /^\/api\/integrations$/,
    /^\/api\/agent-onboarding(?:\/context)?$/,
    new RegExp(`^/api/agent-onboarding/${opaqueId}$`),
    /^\/api\/(contacts|approvals)$/,
    new RegExp(`^/api/contacts/${opaqueId}$`),
    new RegExp(`^/api/contacts/${opaqueId}/control$`),
    /^\/api\/host\/discovery$/,
    new RegExp(`^/api/(threads|artifacts)/${opaqueId}$`),
    new RegExp(`^/api/connections/${opaqueId}/tools$`),
  ],
  POST: [
    new RegExp(`^/api/mcp/access/${opaqueId}$`),
    /^\/api\/integrations\/nango$/,
    new RegExp(`^/api/integrations/nango/recovery/${opaqueId}/retire$`),
    new RegExp(`^/api/integrations/nango/${opaqueId}/renew$`),
    /^\/api\/roomie\/(messages|actions|links)$/,
    /^\/api\/group-rules$/,
    /^\/api\/play-network$/,
    new RegExp(`^/api/chats/${opaqueId}/(sharing|artifacts)$`),
    /^\/api\/playrooms$/,
    new RegExp(`^/api/playrooms/${opaqueId}/(invite|actions)$`),
    /^\/api\/sharing(?:\/invite)?$/,
    /^\/api\/im\/settings$/,
    new RegExp(`^/api/threads/${opaqueId}/reactions$`),
    new RegExp(`^/api/library/artifacts/${opaqueId}/(files|preview|share|resolve-local|change)$`),
    new RegExp(`^/api/(creation-proposals|capability-requests)/${opaqueId}/decision$`),
    new RegExp(`^/api/creation-proposals/${opaqueId}/change$`),
    new RegExp(`^/api/capability-requests/${opaqueId}/revoke$`),
    new RegExp(`^/api/collaborations/${opaqueId}/control$`),
    /^\/api\/workspace\/onboarding$/,
    /^\/api\/(threads|connections|memories)$/,
    /^\/api\/agent-onboarding$/,
    new RegExp(`^/api/agent-onboarding/${opaqueId}/(adopt|cancel)$`),
    /^\/api\/(contacts|chats)$/,
    new RegExp(`^/api/(contacts|chats)/${opaqueId}$`),
    new RegExp(`^/api/contacts/${opaqueId}/(control|run|info)$`),
    /^\/api\/integrations\/(refresh|connect)$/,
    /^\/api\/nodes\/connect$/,
    new RegExp(`^/api/nodes/${opaqueId}/check$`),
    /^\/api\/integrations\/local\/(codex|claude|pi)$/,
    /^\/api\/integrations\/local\/pi\/identity$/,
    new RegExp(`^/api/threads/${opaqueId}/(messages|read|retry|reconcile|cancel)$`),
    new RegExp(`^/api/decisions/${opaqueId}$`),
  ],
  DELETE: [new RegExp(`^/api/(connections|memories)/${opaqueId}$`)],
};

export function readNativeIntegration(value: unknown): NativeIntegrationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native integration");
  const input = value as Record<string, unknown>;
  const keys: Record<string, string[]> = {
    services: [], connect: ["serviceId"], progress: ["flowId"], cancel: ["flowId"], choose: ["flowId", "choiceId"],
    submit: ["flowId", "value"], open: ["instanceId"], remove: ["instanceId"], reconnect: ["instanceId"],
    "local-login": ["agentId"], "local-login-status": ["flowId"], "local-login-cancel": ["flowId"],
  };
  if (typeof input.kind !== "string" || !Object.hasOwn(keys, input.kind)) throw new Error("Unknown native action");
  const allowed = keys[input.kind]!;
  if (Object.keys(input).some(key => key !== "kind" && !allowed.includes(key))) throw new Error("Unsupported native action field");
  for (const key of allowed) {
    const item = input[key];
    if (typeof item !== "string" || !item || item.length > (key === "value" ? 8000 : 200) || (key !== "value" && !/^[A-Za-z0-9_-]+$/.test(item))) throw new Error("Invalid native action parameter");
  }
  if (input.kind === "connect" && !["grokbot", "muse", "dots", "cue"].includes(input.serviceId as string)) throw new Error("Unknown personal service");
  if (input.kind === "local-login" && !["codex", "claude"].includes(input.agentId as string)) throw new Error("Unknown local agent");
  return input as NativeIntegrationRequest;
}

/** Fixed local API capabilities; never URLs, arbitrary headers, streams or files. */
export function readPersonalRequest(value: unknown): PersonalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid personal request");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["path", "method", "body"].includes(key))) throw new Error("Unsupported personal request field");
  if (typeof input.path !== "string" || typeof input.method !== "string" || !Object.hasOwn(routes, input.method)) throw new Error("Invalid personal route");
  const method = input.method as PersonalRequest["method"];
  if (!routes[method].some((route) => route.test(input.path as string))) throw new Error("Personal route is not allowed");
  if (method === "POST") {
    if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) throw new Error("A JSON object is required");
    if (new TextEncoder().encode(JSON.stringify(input.body)).byteLength > 2_000_000) throw new Error("Personal request is too large");
  } else if (input.body !== undefined) throw new Error("This personal method does not accept a body");
  return { path: input.path, method, ...(input.body === undefined ? {} : { body: input.body }) };
}

export function isArtifactId(value: unknown): value is string {
  return typeof value === "string" && /^art_[A-Za-z0-9_-]{1,155}$/.test(value);
}

/** A pathname, origin and top-frame check belong at the main-process IPC boundary. */
export function isTrustedDocument(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual), b = new URL(expected);
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname && !a.username && !a.password;
  } catch { return false; }
}

export function personalCsp(developmentUrl?: string): string {
  const script = ["'self'"], connect = ["'none'"];
  if (developmentUrl) {
    const dev = new URL(developmentUrl);
    script.push("'unsafe-inline'");
    connect.splice(0, 1, dev.origin, `${dev.protocol === "https:" ? "wss:" : "ws:"}//${dev.host}`);
  }
  return ["default-src 'none'", `script-src ${script.join(" ")}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:", `connect-src ${connect.join(" ")}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'", "frame-src agentroom-artifact:"].join("; ");
}
