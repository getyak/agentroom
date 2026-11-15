import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkStrike from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import {
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Check, Copy } from "lucide-react";

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = useRef<HTMLPreElement>(null);
  const language = isValidElement<{ className?: string }>(children)
    ? children.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]
    : undefined;
  return (
    <div className="code-block">
      <div className="code-header">
        <span className="code-language" data-testid="im-code-language">{language || "代码"}</span>
        <button
          type="button"
          className="code-copy"
          data-testid="im-code-copy"
          aria-label={copied ? "代码已复制" : "复制代码"}
          onClick={async () => {
            const text = code.current?.textContent ?? "";
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre ref={code} tabIndex={0} data-testid="im-code-content">{children}</pre>
    </div>
  );
}

const SourceContext = createContext<((id: string) => void) | undefined>(
  undefined,
);

function SourceLink({
  children,
  href,
  node: _node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  const onSource = useContext(SourceContext);
  if (!href?.startsWith("#"))
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        let id = href.slice(1);
        try {
          id = decodeURIComponent(id);
        } catch {
          /* A malformed fragment remains inert source text. */
        }
        if (id.startsWith("source-") && onSource) onSource(id.slice(7));
        else
          event.currentTarget
            .closest(".prose")
            ?.querySelector(`#${CSS.escape(id)}`)
            ?.scrollIntoView({ block: "nearest" });
      }}
    >
      {children}
    </a>
  );
}

function TableBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () =>
      setOverflow(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    check();
    return () => observer.disconnect();
  }, [children]);
  return (
    <div className="table-block">
      <div
        ref={ref}
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label="表格，可横向滚动"
      >
        <table>{children}</table>
      </div>
      {overflow && (
        <p className="table-hint">左右滑动查看完整表格，键盘可用方向键</p>
      )}
    </div>
  );
}

function ImageLink({ alt, src }: ComponentProps<"img">) {
  return (
    <a href={src} target="_blank" rel="noreferrer noopener">
      {alt || "查看图片"}（外部图片）
    </a>
  );
}

const markdownComponents = {
  a: SourceLink,
  table: TableBlock,
  pre: CodeBlock,
  img: ImageLink,
};

const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkCjkStrike];

function PreviewBlock({ children }: { children?: React.ReactNode }) {
  return <>{children}{" "}</>;
}

const previewComponents = {
  p: PreviewBlock,
  h1: PreviewBlock,
  h2: PreviewBlock,
  h3: PreviewBlock,
  h4: PreviewBlock,
  h5: PreviewBlock,
  h6: PreviewBlock,
  li: PreviewBlock,
  th: PreviewBlock,
  td: PreviewBlock,
  img: ({ alt }: ComponentProps<"img">) => <>{alt || "图片"}</>,
  br: () => <> </>,
  hr: () => <> </>,
};

// A preview lives inside the chat button: keep inline emphasis, but no links,
// fetched images, controls or block layout. Block boundaries become spaces.
export function MarkdownPreview({ text }: { text: string }) {
  return <span data-testid="im-chat-preview"><Markdown
    remarkPlugins={remarkPlugins}
    components={previewComponents}
    allowedElements={["strong", "em", "del", "code", ...Object.keys(previewComponents)]}
    unwrapDisallowed
    skipHtml
  >{text}</Markdown></span>;
}

// Raw HTML stays disabled. URLs use react-markdown's safe default transform.
// https://github.com/remarkjs/react-markdown#security
export function RichText({
  text,
  reading = false,
  onSource,
}: {
  text: string;
  reading?: boolean;
  onSource?: (id: string) => void;
}) {
  return (
    <SourceContext.Provider value={onSource}>
      <div className={`prose${reading ? " prose-reading" : ""}`}>
        <Markdown
          remarkPlugins={remarkPlugins}
          components={markdownComponents}
        >
          {text}
        </Markdown>
      </div>
    </SourceContext.Provider>
  );
}
