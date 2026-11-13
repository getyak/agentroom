import type { AgentAvatar, AvatarActivity } from "../server/agent-avatar.mjs";
export type { AgentAvatar, AvatarActivity } from "../server/agent-avatar.mjs";
export type Status =
  | "queued"
  | "running"
  | "needs_input"
  | "blocked"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";
export type Mode = "codex" | "local" | "connection";
export type LocalAgentId = "codex" | "claude" | "pi" | "gemini" | "opencode";
export type AgentConfiguration = { modelMode: "follow" | "fixed"; provider?: string; model?: string; thinking: string };
export type AgentProfile = {
  agentId: LocalAgentId; defaults: { provider: string | null; model: string | null; thinking: string | null };
  models: { provider: string; id: string; name: string; reasoning: boolean; images?: boolean; thinkingLevels?: string[] }[];
  providers: string[]; thinkingLevels: string[]; modelThinkingLevels: Record<string, string>; source: string; version: string; description: string;
};
export type ExecutionSnapshot = { agentId: LocalAgentId; provider: string | null; model: string | null; thinking: string | null; configurationVersion: string; modelPolicy: string; thinkingPolicy: string };
export type LocalAgent = {
  id: LocalAgentId;
  name: string;
  installed: boolean;
  version: string | null;
  auth: { status: "configured" | "required" | "unknown" | "unsupported"; method?: string };
  execution: { supported: boolean; reason?: string };
  profile?: AgentProfile;
  setupUrl: string;
  loginCommandId: string | null;
};
export type Integrations = {
  checkedAt: string;
  agents: LocalAgent[];
  selectedLocalAgentId: LocalAgentId;
  presets: { id: string; name: string; description: string; account: string; connectionId: string | null }[];
  nodes?: RemoteNode[];
};
export type Presence = { state: "online" | "reconnecting" | "offline" | "attention" | "unknown"; deviceName: string; lastSeenAt?: string | null; checkedAt?: string; reason?: string; running?: number; waiting?: number };
export type RemoteNode = {
  presence?: Presence;
  id: string; name: string; origin: string; status: "reachable" | "unreachable" | "attention"; checkedAt: string;
  agents: { id: string; name: string; url: string; availability: "configured" | "not_installed" | "login_required" | "unknown" | "withdrawn" | "unsupported" | "configuration_required"; connectionId: string }[];
};
export type Attachment = {
  id?: string;
  name: string;
  text: string;
  size?: number;
};
export type Reaction = { emoji: string; contactId: string; contactSnapshot?: Contact; runId?: string; createdAt: string };
export type IMSettings = { version: number; allowSilence: boolean };
export type Message = {
  reactions?: Reaction[];
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  attachments?: Attachment[];
  artifactId?: string;
  runId?: string;
  contactId?: string;
  contactSnapshot?: Contact;
  replyTo?: string | null;
  deliveryState?: string;
  skippedContacts?: { id: string; name: string; reason: string }[];
};
export type Run = {
  deliveryState?: "not_sent" | "sending" | "delivered" | "unknown";
  collaboration?: { workId: string; stepId: string };
  id: string;
  status: Status;
  mode: Mode;
  localAgentId?: LocalAgentId;
  connectionId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  externalTaskId?: string;
  requestedMode?: Mode;
  chosenExecutor?: string;
  routingReason?: string;
  remoteReceipt?: unknown;
  externalVerification?: unknown;
  requiresReconciliation?: boolean;
  cancelPending?: boolean;
  stopUnconfirmed?: boolean;
  contactId?: string;
  contactSnapshot?: Contact;
  messageId: string;
  participation?: { action: "reply" | "silence" | "reaction"; reason?: string; emoji?: string };
  imPolicy?: { allowSilence: boolean; allowReactions: boolean };
  inputReceipt?: { state: "supplied" | "acknowledged"; messageIds: string[]; suppliedAt: string; acknowledgedAt?: string };
  progress?: { phase: "preparing" | "thinking" | "writing"; text: string; updatedAt: string };
  executionSnapshot?: ExecutionSnapshot;
};
export type Artifact = {
  id: string;
  title: string;
  mimeType: string;
  size: number;
  sha256: string;
  runId: string;
  createdAt: string;
  verifiedAt?: string;
  body?: string;
};
export type Decision = {
  kind?: "provider_approval";
  runId?: string;
  createdAt?: string;
  providerConnectionId?: string;
  requestType?: "question" | "choice" | "authorization";
  operationType?: "mcp" | "a2a";
  authority?: "agentroom" | "provider" | "original_app_only";
  capabilities?: { response?: "agentroom" | "original_app"; authorization?: "provider_gate" | "local_gate"; canRepeat?: boolean; cancellation?: string; retry?: string };
  facts?: { interaction: string; response: string; execution: string; verification: string; localArtifactVerification?: string; verificationScope?: string | null };
  authorization?: { kind: "conversation_exact"; state: "active" | "revoked" | "expired" | "exhausted"; grantId: string; expiresAt: string; remaining: number; maxUses: number; scope: string };
  choiceLabel?: string | null;
  providerSource?: "original" | "agentroom" | null;
  identity?: {
    label: string;
    authentication: "none" | "bearer";
    identityVerified: boolean;
  };
  id: string;
  version: number;
  title: string;
  summary: string;
  preview: unknown;
  choices: { key: string; label: string }[];
  state: string;
  decision: { choice: string; decidedAt: string; basis?: "owner" | "grant" } | null;
  deliveryState: string | null;
  actionState: string | null;
  verificationState: string | null;
};
export type GroupAvatar = { kind: "preset"; icon: "room" | "spark" | "code" | "compass" | "leaf" | "coffee"; color: "teal" | "blue" | "violet" | "orange" | "rose" } | { kind: "image"; dataUrl: string };
export type ThreadSummary = {
  id: string;
  title: string;
  status: Status;
  summary: string;
  updatedAt: string;
  kind?: "direct" | "group";
  memberIds?: string[];
  groupAvatar?: GroupAvatar | null;
  version?: number;
  lastMessage?: { text: string; contactId?: string } | null;
  pendingApprovals?: number;
  unreadCount?: number;
};
export type Thread = ThreadSummary & {
  creation?: CreationState;
  createdAt: string;
  messages: Message[];
  runs: Run[];
  artifacts: Artifact[];
  decisions: Decision[];
  events: { id: string; type: string; text: string; createdAt: string }[];
  responsePolicies?: Record<string, ResponsePolicy>;
  allowSilence?: boolean | null;
};
export type Connection = {
  id: string;
  name: string;
  type: "a2a" | "mcp";
  url: string;
  node?: { id: string; name: string; agentId: string; origin: string; taskIdScheme: "messageId" };
  status?: string;
  capabilities?: unknown;
  error?: string;
  auth?: {
    type: "none" | "bearer";
    configured: boolean;
    identityVerified: boolean;
  };
};
export type Memory = { id: string; text: string; createdAt: string };
export type ResponsePolicy = "auto" | "mention" | "always" | "manual";
export type Contact = {
  systemRole?: "guide";
  avatar?: AgentAvatar | null;
  avatarActivity?: AvatarActivity;
  presence?: Presence | null;
  chatBackend?: { type: "local"; localAgentId: LocalAgentId } | null;
  connectionType?: "a2a" | "mcp" | null;
  id: string; kind: "agent" | "human"; name: string; handle: string;
  sourceName?: string; nameSource?: "provider" | "custom";
  description: string; instructions: string; color: string; version: number;
  icon?: string; avatarAgent?: LocalAgentId; avatarService?: import("./desktop-contract").PersonalServiceId; avatarDataUrl?: string; configuration?: AgentConfiguration; profile?: AgentProfile | null; execution?: ExecutionSnapshot | null; configurationError?: string;
  discovered?: boolean; added?: boolean; providerName?: string;
  binding: { type: "local"; localAgentId: LocalAgentId } | { type: "connection"; connectionId: string } | null;
  availability: "self" | "ready" | "unsupported" | "not_installed" | "login_required" | "disconnected" | "local_only" | "configuration_required";
  availabilityReason?: string;
};
export type Approval = Decision & {
  threadId: string; threadTitle: string; contact: Contact | null;
  source?: { label: string; name: string | null; connectionId: string | null; botId: string | null; requestText: string | null; threadKind: "direct" | "group" | "task" };
};
export type Bootstrap = {
  workspace?: { onboardingCompleted: boolean; displayName: string; guide?: { contactId: string; threadId: string; agentId: LocalAgentId | null; providerName: string | null; reason: string; executionVerified: false } | null };
  threads: ThreadSummary[];
  connections: Connection[];
  memories: Memory[];
  settings: { im?: IMSettings; defaultMode: Mode; codexAvailable: boolean; localAgentId?: LocalAgentId };
  runtime?: Record<string, unknown>;
};

export type OnboardingSource = { id: string; kind: "role" | "group" | "message" | "memory"; targetId: string; label: string; text?: string; description?: string; instructions?: string; handle?: string };
export type OnboardingContext = { sources: OnboardingSource[]; counts: { roles: number; groups: number; memories: number }; scope: { includeRecentMessages: boolean; includeMemories: boolean; privateMessages: boolean }; truncation: { omitted: number; clipped: number; characterBudget: number } };
export type RoleSuggestion = { id: string; name: string; handle: string; description: string; instructions: string; rationale: string; sourceIds: string[]; groupIds: string[]; color: string; avatar?: AgentAvatar; contactId?: string };
export type OnboardingJob = OnboardingContext & { id: string; threadId: string; agentId: LocalAgentId; status: "queued" | "probing" | "analyzing" | "completed" | "failed" | "interrupted" | "cancelled"; goal: string; cancelPending?: boolean; stopUnconfirmed?: boolean; createdAt: string; updatedAt: string; executionSnapshot: ExecutionSnapshot; probe: { status: "pending" | "passed"; testedAt?: string }; suggestions: RoleSuggestion[]; habits: { text: string; sourceIds: string[]; inferred: true }[]; error?: string };

export type WorkspaceArtifact = { id: string; title: string; kind: 'document' | 'website'; status: string; headRevisionId: string | null; currentRevisionId: string | null; deliveredRevisionId?: string | null; acceptedRevisionId: string | null; materializationState: string; version: number; createdAt: string; updatedAt: string };
export type ArtifactRevision = { id: string; artifactId: string; parentRevisionId: string | null; state: string; files: Record<string, { sha256: string; size: number }>; createdAt: string };
export type ArtifactLink = { version?: number; id: string; artifactId: string; threadId: string; revisionId: string; follow: boolean; paths: string[]; audienceIds: string[]; state: string };
export type CreationProposal = { id: string; title: string; kind: string; goal: string; artifactId: string | null; baseRevisionId: string | null; messageId: string; state: string; version: number; error?: string; workId?: string; audienceIds: string[]; sourceNames: string[]; readPaths: string[]; publishPaths: string[]; participants: { contactId: string; localAgentId: string; contactSnapshot: { name: string }; executionSnapshot: ExecutionSnapshot }[]; contributors: { contactId: string; task: string; notes: string; writePaths: string[]; dependsOnContacts: string[] }[] };
export type Collaboration = { id: string; title: string; status: string; threadId: string; artifactId: string | null; finalRevisionId?: string; error?: string; finalChecks?: { passed: boolean; errors: string[]; scope: string }; previewChecks?: { passed: boolean; errors: string[] }; steps: { id: string; runIds?: string[]; contributionId?: string; contactId: string; task: string; status: string; error?: string; submittedRevisionId?: string; summary?: string }[] };
export type CapabilityRequest = { workId?: string; id: string; capability: string; reason: string; state: string; version: number; artifactId: string | null; revisionId: string | null; paths: string[]; contactId: string; requestedBy: string; audienceIds: string[] };
export type CreationState = { proposals: CreationProposal[]; collaborations: Collaboration[]; links: ArtifactLink[]; permissionRequests: CapabilityRequest[]; toolActivity: { id: string; name: string; contactId: string; state: string; ok?: boolean; createdAt: string }[] };
export type ArtifactDetail = { artifact: WorkspaceArtifact; revisions: ArtifactRevision[]; links: ArtifactLink[]; contributions: { id: string; contactId: string; runId: string; revisionId?: string; state: string; summary?: string; createdAt: string }[]; collaborations: Collaboration[]; permissions: CapabilityRequest[]; ownerOperations: { id: string; action: string; state: string }[] };

export type OwnerCollaboration = Collaboration & { messages?: { text: string; fromContactId?: string; kind?: string }[]; runs: Run[] };
