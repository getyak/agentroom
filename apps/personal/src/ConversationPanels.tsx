import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, FileText, Loader2, ShieldCheck, Trash2, X } from "lucide-react";
import { api, key } from "./api";
import { desktopBridge } from "./native";
import { RichText } from "./Markdown";
import { Connections } from "./Connections";
import { WorkspaceTools } from "./WorkspaceTools";
import type { Artifact, Attachment, Bootstrap, Decision } from "./types";
import "./preferences.css";

const errorText = (error: unknown) => error instanceof Error ? error.message : "暂时无法连接，内容已保留。";
const storage = {
  get<T>(name: string, fallback: T): T {
    try { return JSON.parse(localStorage.getItem(`agentstudio.personal.${name}`) || "null") ?? fallback; } catch { return fallback; }
  },
  set(name: string, value: unknown) {
    try { localStorage.setItem(`agentstudio.personal.${name}`, JSON.stringify(value)); } catch { /* Reading remains available when preferences cannot be saved. */ }
  },
};

export function Modal({
  title,
  children,
  onClose,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      data-testid="personal-modal"
      className={`modal ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div className="modal-inner">
        <header className="modal-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            data-testid="personal-modal-close"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function Reader({
  artifact,
  sources,
  onClose,
}: {
  artifact: Artifact;
  sources: Attachment[];
  onClose: () => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [large, setLarge] = useState(storage.get("large-type", false));
  const [source, setSource] = useState<Attachment | null>(null);
  const [downloadNote, setDownloadNote] = useState("");
  const [saving, setSaving] = useState(false);
  const desktop = desktopBridge();
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    api<Artifact>(`/artifacts/${artifact.id}`)
      .then((result) => {
        if (current) setBody(result.body ?? "");
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      });
    return () => {
      current = false;
    };
  }, [artifact.id]);
  useEffect(() => {
    if (body !== null && scroll.current)
      scroll.current.scrollTop = storage.get(`reader.${artifact.id}`, 0);
  }, [body, artifact.id]);
  return (
    <Modal
      title={artifact.title}
      onClose={onClose}
      className={`reader-modal${large ? " large-type" : ""}`}
    >
      <div className="reader-toolbar">
        <span>
          <FileText size={14} /> Markdown
        </span>
        <div>
          <button
            className="text-button"
            data-testid="personal-reader-font"
            aria-pressed={large}
            onClick={() => {
              setLarge(!large);
              storage.set("large-type", !large);
            }}
          >
            字号 {large ? "大" : "标准"}
          </button>
          {desktop ? <button
            className="text-button"
            data-testid="personal-reader-download"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              setDownloadNote("");
              try {
                const result = await desktop.saveArtifact(artifact.id);
                if (!result.cancelled) setDownloadNote(`已保存 ${result.fileName ?? "报告"}`);
              } catch (error) {
                setDownloadNote(errorText(error));
              } finally {
                setSaving(false);
              }
            }}
          >
            <Download size={15} />
            {saving ? "正在保存…" : "存储原文…"}
          </button> : <a
            className="text-button"
            data-testid="personal-reader-download"
            href={`/api/artifacts/${artifact.id}/download`}
            download
          >
            <Download size={15} />
            下载原文
          </a>}
        </div>
      </div>
      {downloadNote && <p className="native-save-note" role="status" data-testid="personal-save-receipt">{downloadNote}</p>}
      <div
        className="reader-scroll"
        ref={scroll}
        data-testid="personal-reader"
        onScroll={(event) =>
          storage.set(`reader.${artifact.id}`, event.currentTarget.scrollTop)
        }
      >
        {error ? (
          <p role="alert" className="error-text">
            {error}
          </p>
        ) : body === null ? (
          <p className="muted">
            <Loader2 size={16} className="working" /> 正在打开原文…
          </p>
        ) : (
          <RichText
            text={body}
            reading
            onSource={(id) => {
              const found = sources.find((item) => item.id === id);
              if (found) setSource(found);
              else
                setSourceError(
                  "这处引用没有对应的已保存资料，报告仍可继续阅读。",
                );
            }}
          />
        )}
        {sourceError && (
          <p className="error-text" role="alert">
            {sourceError}
          </p>
        )}
        <footer className="verification">
          <ShieldCheck size={16} />
          <div>
            <strong>
              {artifact.verifiedAt ? "文件已读回校验" : "尚无文件校验证据"}
            </strong>
            <p>校验说明保存的文件字节一致；内容判断仍可在对话中继续修订。</p>
            <details>
              <summary>查看文件指纹</summary>
              <code>{artifact.sha256}</code>
              <p>
                {artifact.size.toLocaleString()} 字节
                {artifact.verifiedAt
                  ? `，校验于 ${new Date(artifact.verifiedAt).toLocaleString("zh-CN")}`
                  : ""}
              </p>
            </details>
          </div>
        </footer>
      </div>
      {source && (
        <Modal
          title={source.name}
          onClose={() => setSource(null)}
          className="reader-modal"
        >
          <div className="reader-scroll">
            <p className="section-intro">
              这份原文随当前事情保存。关闭后继续阅读报告。
            </p>
            <RichText text={source.text} reading />
          </div>
        </Modal>
      )}
    </Modal>
  );
}

export function Preferences({
  data,
  onRefresh,
  onClose,
  initialTab = "connections",
  onWelcome,
}: {
  data: Bootstrap;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  initialTab?: "connections" | "im" | "memory" | "about" | "testing";
  onWelcome?: () => void;
}) {
  const [tab, setTab] = useState<"connections" | "im" | "memory" | "about" | "testing">(
    initialTab,
  );
  const [memory, setMemory] = useState("");
  const [allowSilence, setAllowSilence] = useState(data.settings.im?.allowSilence ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [verticalTabs, setVerticalTabs] = useState(() => window.matchMedia("(min-width: 641px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 641px)");
    const update = () => setVerticalTabs(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const mutate = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await onRefresh();
      setMemory("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="连接与偏好" onClose={onClose} className="preferences-modal">
      <div className="preferences-layout">
      <div className="preference-tabs" role="tablist" aria-label="设置分类" aria-orientation={verticalTabs ? "vertical" : "horizontal"} onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
        buttons[next]?.click();
      }}>
        {(
          [
            ["connections", "连接"],
            ["im", "聊天回应"],
            ["memory", "记忆"],
            ["about", "运行说明"],
            ["testing", "测试与引导"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            data-testid={`personal-tab-${id}`}
            role="tab"
            id={`preference-tab-${id}`}
            aria-controls="preference-panel"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => {
              setTab(id);
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="preferences-content" key={tab} id="preference-panel" role="tabpanel" aria-labelledby={`preference-tab-${tab}`} tabIndex={0} data-testid="personal-preference-panel">
        {tab === "im" && <section className="im-preferences" data-testid="im-preferences"><h3>聊天回应</h3><label className="im-silence-toggle"><input type="checkbox" data-testid="im-allow-silence" checked={allowSilence} disabled={busy} onChange={event => { const next = event.target.checked; setAllowSilence(next); void mutate(async () => { try { return await api("/im/settings", { version: data.settings.im?.version ?? 0, allowSilence: next, clientId: key() }); } catch (error) { setAllowSilence(data.settings.im?.allowSilence ?? true); throw error; } }); }} /><span>允许静默</span></label><p className="section-intro">Agent 读取消息后，按自己的角色和风格选择文字回复、表情回应或保持安静。关闭后需要文字或表情回应；群聊可以单独设置。更改用于之后发送的消息。</p><p className="im-field-hint">各成员独立处理，不等待所有人发言。当前接入不支持的回应方式仍以普通文字显示。</p></section>}
        {tab === "testing" && <WorkspaceTools onRefresh={onRefresh} onWelcome={onWelcome} />}
        {tab === "connections" && (
          <Connections data={data} onRefresh={onRefresh} />
        )}
        {tab === "memory" && (
          <>
            <p className="section-intro">
              只记住你明确保存的内容。这里的偏好会用于之后的执行，随时可以修正。
            </p>
            {data.memories.length === 0 && (
              <p className="quiet-empty">
                还没有长期记忆。比如，你可以记住“报告先给结论，并保留来源”。
              </p>
            )}
            {data.memories.map((item) => (
              <div key={item.id} className="memory-row">
                <p>{item.text}</p>
                <button
                  className="icon-button"
                  aria-label="移除这条记忆"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() =>
                      api(`/memories/${item.id}`, undefined, "DELETE"),
                    )
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void mutate(() =>
                  api("/memories", { text: memory, clientId: key() }),
                );
              }}
            >
              <label className="sr-only" htmlFor="memory-input">
                要记住的偏好
              </label>
              <textarea
                id="memory-input"
                data-testid="personal-memory-input"
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
                placeholder="有件事，希望你以后记住…"
                rows={3}
                required
                maxLength={4000}
              />
              <div className="form-actions">
                <button
                  className="primary-button"
                  data-testid="personal-memory-save"
                  disabled={busy || !memory.trim()}
                >
                  记住这件事
                </button>
              </div>
            </form>
          </>
        )}
        {tab === "about" && (
          <div className="about-copy">
            <h3>AgentRoom</h3>
            <h3>对话可以关闭，事情会留下。</h3>
            <p>
              浏览器关闭后，正在运行的本地服务会继续工作。电脑休眠、离线或服务停止期间，不能保证执行继续；回来后会读取真实状态。
            </p>
            <h3>账号与资料</h3>
            <p>
              数据保存在这台电脑的本地工作区。本机助手沿用已有
              {data.settings.localAgentId === "claude" ? " Claude Code " : " Codex "}
              配置，向相应模型提供本次事情的上下文。远端服务使用它自己的账号、工具和权限。
            </p>
            <p>
              每次执行只携带这件事的对话、所附文本和明确保存的记忆。当前版本面向本机单人使用，请勿把服务公开到网络。
            </p>
            <h3>决定不等于完成</h3>
            <p>
              你的选择、选择是否送达、动作是否执行和结果是否核验会分别记录。外部写入失联时先核查，不直接重复提交。
            </p>
            <h3>结果可以带走</h3>
            <p>
              报告保存为原始
              Markdown，并附文件指纹。校验通过说明文件字节一致，不代表内容已经由你接受。
            </p>
          </div>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      </div>
    </Modal>
  );
}

export function DecisionView({
  decision,
  onDecide,
  busy,
  onOpenOriginal,
}: {
  decision: Decision;
  onDecide: (choice: string) => void;
  busy: boolean;
  onOpenOriginal?: () => void;
}) {
  const pending = decision.state === "pending";
  const provider = decision.kind === "provider_approval";
  const originalOnly = decision.authority === "original_app_only" || decision.capabilities?.response === "original_app";
  const responseState = decision.facts?.response || decision.deliveryState || "not_sent";
  const heading = pending ? originalOnly ? "需要在原应用处理" : provider ? "需要你选择" : "需要你授权这项操作"
    : decision.state === "sending" ? "正在同步你的选择" : decision.state === "unknown" ? "回传结果待核查"
    : decision.state === "cancelled" ? "这项请求已失效" : provider ? responseState === "delivered" ? "选择已送达" : "原卡已处理" : "决定已记录";
  const preview =
    typeof decision.preview === "string"
      ? decision.preview
      : JSON.stringify(decision.preview, null, 2);
  let readable: {
    endpoint?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
    content?: { request?: string; sources?: { name: string }[] };
  } | null = null;
  try {
    readable = JSON.parse(preview);
  } catch {
    /* Protocol-specific previews remain available below. */
  }
  const labels: Record<string, string> = {
    repoName: "仓库",
    question: "问题",
    path: "文件路径",
    url: "网址",
    content: "内容",
    text: "内容",
    title: "标题",
    to: "接收人",
    key: "记录",
    value: "值",
  };
  const receipt: Record<string, string> = {
    not_sent: "未发送",
    sending: "发送中",
    queued: "等待送达",
    delivered: "已送达",
    not_started: "尚未开始",
    running: "进行中",
    completed: "已返回结果",
    failed: "未成功",
    unknown: "待核查",
    verified: "已记录核验范围",
    not_provided: "未提供独立核验",
    cancelled: "已停止本机等待",
    not_observed: "尚未收到操作结果",
    not_required: "未从本机回传",
    stale: "未发送，原请求已变化",
  };
  const localService = (() => {
    try {
      const endpoint = new URL(readable?.endpoint || "");
      return ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) && /^\/a2a\/[A-Za-z0-9_-]+$/.test(endpoint.pathname);
    } catch { return false; }
  })();
  return (
    <section
      className={`decision${pending ? " decision-pending" : ""}`}
      data-testid="personal-decision"
      data-decision-id={decision.id}
    >
      <div className="decision-heading">
        <span className="decision-dot" />
        <strong>{heading}</strong>
      </div>
      <h3>{decision.title}</h3>
      <p>{decision.summary}</p>
      {decision.kind === "provider_approval" && decision.providerSource && <p>{decision.providerSource === "original" ? "已在 Grok Bot 处理，状态已同步" : "从 AgentRoom 回传给 Grok Bot"}</p>}
      {readable && (
        <dl className="decision-scope">
          {decision.identity && (
            <div>
              <dt>使用身份</dt>
              <dd>
                {decision.identity.label}，
                {localService ? "沿用连接时的服务登录；账号归属尚未独立核验" : decision.identity.authentication === "bearer"
                  ? "使用该连接保存的凭据，由服务端验证账号"
                  : "公开访问，不使用账号凭据"}
              </dd>
            </div>
          )}
          {readable.endpoint && (
            <div>
              <dt>发送到</dt>
              <dd>{localService ? `${decision.identity?.label || "个人 Agent"} · 通过这台 Mac 连接` : readable.endpoint}</dd>
            </div>
          )}
          {Object.entries(readable.params?.arguments ?? {}).map(
            ([name, value]) => (
              <div key={name}>
                <dt>{labels[name] ?? name}</dt>
                <dd>
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </dd>
              </div>
            ),
          )}
          {readable.content?.request && (
            <div>
              <dt>这次要求</dt>
              <dd>{readable.content.request}</dd>
            </div>
          )}
          {readable.content?.sources && readable.content.sources.length > 0 && (
            <div>
              <dt>所附资料</dt>
              <dd>
                {readable.content.sources
                  .map((source) => source.name)
                  .join("、")}
              </dd>
            </div>
          )}
        </dl>
      )}
      <details>
        <summary>查看完整发送内容与技术信息</summary>
        <pre className="decision-preview" tabIndex={0}>
          {preview}
        </pre>
      </details>
      {pending && originalOnly ? <div className="decision-original" data-testid="personal-decision-original"><p>请在原应用中处理这项权限，状态会同步到这里。</p>{onOpenOriginal && <button className="secondary-button" data-testid="personal-decision-open-original" onClick={onOpenOriginal}>打开原应用</button>}</div> : pending ? (
        <>
        <div className="decision-actions">
          {decision.choices.map((choice) => (
            <button
              key={choice.key}
              className={
                choice.key === "approve" ? "primary-button" : "secondary-button"
              }
              disabled={busy}
              data-testid={`personal-decision-${choice.key}`}
              onClick={() => onDecide(choice.key)}
            >
              {busy ? "正在记录…" : choice.label}
            </button>
          ))}
        </div>
        {!provider && decision.capabilities?.canRepeat && <details className="decision-grant-option"><summary>在本次对话内复用这项授权</summary><p>仅允许相同工具、相同参数和所列读回。有效期 1 小时，最多 10 次相同操作，可以随时撤销。</p><button className="secondary-button" disabled={busy} data-testid="personal-decision-approve-conversation" onClick={() => onDecide("approve_conversation")}>对话内允许相同操作</button></details>}
        </>
      ) : (
        <div className="decision-receipt">
          <span>
            选择：
            {provider ? decision.choiceLabel || "请在原应用核查" : decision.decision?.choice === "approve"
              ? "同意"
              : decision.state === "cancelled"
                ? "预览已失效"
                : "未同意"}
          </span>
          <span>
            送达：
            {receipt[responseState] ?? responseState}
          </span>
          {!provider && <span>
            执行：
            {receipt[decision.facts?.execution || decision.actionState || "not_started"] ??
              decision.actionState}
          </span>}
          {!provider && <span>
            核验：
            {(decision.facts?.verification || decision.verificationState) === "failed" ? decision.facts?.verificationScope === "mcp_explicit_readback" ? "读回核验未通过" : "核验未通过" : decision.facts?.verificationScope === "local_artifact_readback" ? "本机保存的结果已校验" : decision.facts?.verificationScope === "mcp_explicit_readback" && decision.verificationState === "verified" ? "指定读回符合预期" : receipt[decision.facts?.verification || decision.verificationState || "not_provided"] ??
              decision.verificationState}
          </span>}
          {!provider && (decision.facts?.verificationScope !== "local_artifact_readback" && decision.facts?.localArtifactVerification === "verified" || decision.facts?.verificationScope === "local_artifact_readback" && decision.verificationState === "failed") && <span>本机保存的结果已校验</span>}
          {provider && <span>后续操作结果请查看原聊天或原应用。</span>}
        </div>
      )}
      {!provider && decision.authorization && <div className="decision-grant" data-testid="personal-decision-grant"><p>{decision.authorization.state === "active" ? `相同操作授权 · 剩余 ${decision.authorization.remaining}/${decision.authorization.maxUses} 次 · ${new Date(decision.authorization.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 到期` : decision.authorization.state === "revoked" ? "后续授权已撤销" : decision.authorization.state === "exhausted" ? "授权次数已用完" : "持续授权已到期"}</p>{decision.authorization.state === "active" && <button className="im-text-button" disabled={busy} data-testid="personal-decision-revoke" onClick={() => onDecide("revoke")}>撤销后续授权</button>}</div>}
    </section>
  );
}

