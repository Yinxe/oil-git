import { useEffect, useState } from "react";
import { request, errorOf } from "./api";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icon";
import { ReadStatus } from "./ReadStatus";
import type { DiffOrigin, GitError, LineOrigin } from "./types";

export function LineAttribution({
  origin,
  selection,
  onClose,
  active,
}: {
  origin: DiffOrigin;
  selection: { side: "before" | "after"; line: number };
  onClose: () => void;
  active: boolean;
}) {
  const key = JSON.stringify([origin, selection]);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data: LineOrigin | null;
    error: GitError | null;
    busy: boolean;
  }>({ key: "", data: null, error: null, busy: false });
  useEffect(() => {
    if (!active) return;
    let live = true;
    setState({ key, data: null, error: null, busy: true });
    const { repoId, ...context } = origin;
    void request<LineOrigin>("get_line_origin", {
      repoId,
      request: { ...context, ...selection },
    })
      .then((data) => {
        if (live) setState({ key, data, error: null, busy: false });
      })
      .catch((error) => {
        if (live)
          setState({ key, data: null, error: errorOf(error), busy: false });
      });
    return () => {
      live = false;
    };
  }, [key, retry, active]);
  const data = state.key === key ? state.data : null;
  const error = state.key === key ? state.error : null;
  return (
    <section className="line-attribution" aria-label="代码行归属">
      <header>
        <strong>
          {selection.side === "before" ? "变更前" : "变更后"} · 第{" "}
          {selection.line} 行
        </strong>
        <button
          className="icon-button"
          aria-label="关闭行归属"
          title="关闭行归属"
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      <ReadStatus
        busy={!data && !error && active}
        requestKey={key}
        label="正在读取最后修改者…"
      />
      {error && (
        <p className="error-text" role="status">
          {error.message}
          <button onClick={() => setRetry((n) => n + 1)}>重试</button>
        </p>
      )}
      {data && (
        <div className="line-author-content">
          <div>
            <strong>{data.author}</strong>
            {data.email && <span title={data.email}>{data.email}</span>}
            {data.timestamp && (
              <time>
                {new Date(data.timestamp * 1000).toLocaleDateString("zh-CN")}
              </time>
            )}
          </div>
          <p>{data.subject}</p>
          <div>
            {data.hash && (
              <code title={data.hash}>{data.hash.slice(0, 8)}</code>
            )}
            <CopyButton
              label="复制代码行归属"
              text={[
                `${data.path}:${data.line}`,
                `作者：${data.author}${data.email ? ` <${data.email}>` : ""}`,
                `提交：${data.hash ?? "尚未提交"}`,
                `标题：${data.subject}`,
                `原提交行号：${data.originalLine}`,
              ].join("\n")}
            />
          </div>
        </div>
      )}
    </section>
  );
}
