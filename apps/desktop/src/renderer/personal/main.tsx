import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@agentstudio/personal/ui";
import { desktopBridge } from "@agentstudio/personal/native";
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@agentstudio/personal/styles.css";
import "./styles.css";
import { personalEntryAllowed } from "./entry-policy";

const entryAllowed = personalEntryAllowed({ hasBridge: Boolean(desktopBridge()), protocol: location.protocol, hostname: location.hostname });

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    {entryAllowed ? (
      <App />
    ) : (
      <div className="native-startup-error" role="alert">
        <h1>工作间没有启动</h1>
        <p>请退出后重新打开 AgentRoom。已保存的事情不会删除。</p>
      </div>
    )}
  </StrictMode>,
);
