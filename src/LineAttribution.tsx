import { useEffect, useState } from "react";
import { request, errorOf } from "./api";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icon";
import { ReadStatus } from "./ReadStatus";
import type { DiffOrigin, GitError, LineOrigin } from "./types";
import { useI18n } from "./i18n";
import { ErrorMessage } from "./ErrorMessage";

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
  const { t, language } = useI18n();
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
  const author = data ? (data.hash ? data.author : t("尚未提交")) : "";
  const subject = data && (data.hash ? data.subject : t(data.subject));
  return (
    <section className="line-attribution" aria-label={t("代码行归属")}>
      <header>
        <strong>
          {t(selection.side === "before" ? "变更前" : "变更后")} ·{" "}
          {t("第 {line} 行", { line: selection.line })}
        </strong>
        <button
          className="icon-button"
          aria-label={t("关闭行归属")}
          title={t("关闭行归属")}
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      <ReadStatus
        busy={!data && !error && active}
        requestKey={key}
        label={t("正在读取最后修改者…")}
      />
      {error && (
        <div className="error-text" role="status">
          <ErrorMessage error={error} />
          <button onClick={() => setRetry((n) => n + 1)}>{t("重试")}</button>
        </div>
      )}
      {data && (
        <div className="line-author-content">
          <div>
            <strong>{author}</strong>
            {data.email && <span title={data.email}>{data.email}</span>}
            {data.timestamp && (
              <time>
                {new Date(data.timestamp * 1000).toLocaleDateString(
                  language === "en" ? "en-US" : "zh-CN",
                )}
              </time>
            )}
          </div>
          <p>{subject}</p>
          <div>
            {data.hash && (
              <code title={data.hash}>{data.hash.slice(0, 8)}</code>
            )}
            <CopyButton
              label={t("复制代码行归属")}
              text={[
                `${data.path}:${data.line}`,
                t("作者：{value}", {
                  value: `${author}${data.email ? ` <${data.email}>` : ""}`,
                }),
                t("提交：{value}", { value: data.hash ?? t("尚未提交") }),
                t("标题：{value}", { value: subject ?? data.subject }),
                t("原提交行号：{line}", { line: data.originalLine }),
              ].join("\n")}
            />
          </div>
        </div>
      )}
    </section>
  );
}
