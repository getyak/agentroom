import { resolve } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import pkg from "./package.json";
import { desktopSource } from "../../dev/desktop-test-env.mjs";
import { writeFileSync } from "node:fs";

const buildInfo = (() => {
  try { return { ...desktopSource(resolve(__dirname, "../..")), browserWorkspace: 1 }; }
  catch { return { revision: "unknown-source", automation: 0, browserWorkspace: 0 }; }
})();
const sourceRevision = buildInfo.revision;

// Main and preload are emitted as CommonJS (the package is not "type": "module"),
// which the sandboxed preload requires. The renderer is bundled locally and
// loaded with loadFile in production; it never loads remote code.
export default defineConfig({
  main: {
    // Also correct when Electron is started on the bundle file directly.
    define: { __APP_VERSION__: JSON.stringify(pkg.version), __APP_REVISION__: JSON.stringify(sourceRevision) },
    plugins: [{
      name: "agentstudio-personal-runtime",
      buildStart() {
        for (const file of ["decisions.mjs", "decision-views.mjs"]) this.addWatchFile(resolve(__dirname, "../personal/server", file));
        this.addWatchFile(resolve(__dirname, "../personal/server/workspace-guide.mjs"));
        this.addWatchFile(resolve(__dirname, "../personal/server/cc-switch.mjs"));
        for (const file of ["index.mjs", "acp-client.mjs", "assistant-inventory.mjs", "assistant-manager.mjs", "assistant-install.mjs", "roomie.mjs", "roomie-executor.mjs", "agent-binding-identity.mjs", "project-resources.mjs", "playrooms.mjs", "group-sharing.mjs", "group-tools.mjs", "group-artifacts.mjs", "play-executor.mjs", "play-network.mjs", "runtime.mjs", "im-participation.mjs", "store.mjs", "vault.mjs", "local-agents.mjs", "integrations.mjs", "messenger.mjs", "contact-names.mjs", "agent-avatar.mjs", "unread.mjs", "group-avatar.mjs", "agent-profiles.mjs", "agent-info.mjs", "agent-onboarding.mjs", "agent-scheduler.mjs", "host-discovery.mjs", "tool-sessions.mjs", "agentroom-tool-proxy.mjs", "agentroom-pi-tools.mjs", "conversation-sessions.mjs", "conversation-pi.mjs", "agentroom-pi-receipt.mjs", "artifact-store.mjs", "artifact-tools.mjs", "creation-service.mjs", "collaboration-runtime.mjs", "artifact-api.mjs", "provider-approvals.mjs", "native-services.mjs", "remote-nodes.mjs", "desktop-sharing.mjs", "device-network.mjs", "mcp-access.mjs", "chat-tools.mjs", "nango.mjs"]) this.addWatchFile(resolve(__dirname, "../personal/server", file));
        this.addWatchFile(resolve(__dirname, "src/main/worker.mjs"));
      },
      writeBundle() {
        writeFileSync(resolve(__dirname, "out/main/build-info.json"), JSON.stringify(buildInfo, null, 2));
        const output = resolve(__dirname, "out/main/personal");
        mkdirSync(output, { recursive: true });
        for (const file of ["decisions.mjs", "decision-views.mjs"]) copyFileSync(resolve(__dirname, "../personal/server", file), resolve(output, file));
        copyFileSync(resolve(__dirname, "../personal/server/workspace-guide.mjs"), resolve(output, "workspace-guide.mjs"));
        copyFileSync(resolve(__dirname, "../personal/server/cc-switch.mjs"), resolve(output, "cc-switch.mjs"));
        for (const file of ["index.mjs", "acp-client.mjs", "assistant-inventory.mjs", "assistant-manager.mjs", "assistant-install.mjs", "roomie.mjs", "roomie-executor.mjs", "agent-binding-identity.mjs", "project-resources.mjs", "playrooms.mjs", "group-sharing.mjs", "group-tools.mjs", "group-artifacts.mjs", "play-executor.mjs", "play-network.mjs", "runtime.mjs", "im-participation.mjs", "store.mjs", "vault.mjs", "local-agents.mjs", "integrations.mjs", "messenger.mjs", "contact-names.mjs", "agent-avatar.mjs", "unread.mjs", "group-avatar.mjs", "agent-profiles.mjs", "agent-info.mjs", "agent-onboarding.mjs", "agent-scheduler.mjs", "host-discovery.mjs", "tool-sessions.mjs", "agentroom-tool-proxy.mjs", "agentroom-pi-tools.mjs", "conversation-sessions.mjs", "conversation-pi.mjs", "agentroom-pi-receipt.mjs", "artifact-store.mjs", "artifact-tools.mjs", "creation-service.mjs", "collaboration-runtime.mjs", "artifact-api.mjs", "provider-approvals.mjs", "native-services.mjs", "remote-nodes.mjs", "desktop-sharing.mjs", "device-network.mjs", "mcp-access.mjs", "chat-tools.mjs", "nango.mjs"]) copyFileSync(resolve(__dirname, "../personal/server", file), resolve(output, file));
        copyFileSync(resolve(__dirname, "src/main/worker.mjs"), resolve(output, "worker.mjs"));
      },
    }],
    // Brand images are imported with ?asset and copied into out/; don't leave them as a runtime require.
    build: { externalizeDeps: { exclude: ["@agentstudio/brand"] } },
  },
  preload: {
    build: { rollupOptions: { input: {
      index: resolve(__dirname, "src/preload/index.ts"),
      personal: resolve(__dirname, "src/preload/personal.ts"),
    } } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    // Dev server stays on loopback like the rest of the local stack.
    server: { host: "127.0.0.1" },
    build: {
      rollupOptions: { input: {
        legacy: resolve(__dirname, "src/renderer/index.html"),
        personal: resolve(__dirname, "src/renderer/personal/index.html"),
        guest: resolve(__dirname, "src/renderer/guest/index.html"),
      } },
    },
  },
});
