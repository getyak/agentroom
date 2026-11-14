export type AssistantEntry = {
  id: string;
  localAgentId: string;
  name: string;
  description: string;
  kind: "native" | "acp";
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  installSupported: boolean;
  source: "system" | "managed" | null;
  path: string | null;
  repository: string | null;
  reason?: string;
};

export type AssistantOperation = {
  id: string;
  agentId: string;
  action: "install" | "update";
  state: "queued" | "running" | "succeeded" | "failed" | "interrupted";
  version: string | null;
  progress: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type AssistantCatalog = {
  checkedAt: string;
  source: { status: string; checkedAt: string | null; refreshing?: boolean; error?: string };
  entries: AssistantEntry[];
  operations: AssistantOperation[];
};
