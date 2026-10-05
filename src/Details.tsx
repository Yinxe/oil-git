import { useLayoutEffect } from "react";
import { DiffView } from "./DiffView";
import { Icon } from "./Icon";
import { FileIcon } from "./FileIcon";
import { ReadStatus } from "./ReadStatus";
import { useCommitView } from "./useCommitView";
import { CommitMetadata } from "./CommitMetadata";
import { CopyButton } from "./CopyButton";
import { useCommitMotion } from "./useCommitMotion";
import type { GitError, Project, Selection } from "./types";

export type DetailState = {
  ready: boolean;
  loading: boolean;
  error: GitError | null;
};
export function Details({
  project,
  selection,
  onClose,
  active: shown = true,
  onStateChange,
  subject,
  keepPrevious = true,
  commits = [],
}: {
  project: Project;
  selection: Selection;
  onClose: () => void;
  active?: boolean;
  subject?: string;
  keepPrevious?: boolean;
  commits?: readonly { hash: string }[];
  onStateChange?: (state: DetailState) => void;
}) {
  const view = useCommitView(project, selection, shown);
  const data =
    view.data &&
    (keepPrevious ||
      (selection?.kind === "commit" &&
        view.data.detail.hash === selection.hash))
      ? view.data
      : null;
  const stash = selection?.kind === "stashes";
  const ready = stash || !!data || !!view.error;
  const content = useCommitMotion(
    stash ? null : (data?.detail.hash ?? null),
    commits,
    shown && !!selection,
  );
  useLayoutEffect(() => {
    onStateChange?.({ ready, loading: view.loading, error: view.error });
  }, [ready, view.loading, view.error, onStateChange]);
  if (!selection) return null;
  const sameCommit =
    selection.kind === "commit" && data?.detail.hash === selection.hash;
  return (
    <aside className="details" aria-label="所选对象详情" data-ready={ready}>
      {ready && (
        <div
          className="detail-content"
          ref={content}
          key={stash ? "stashes" : (data?.detail.hash ?? "error")}
        >
          <header className="details-header">
            <div className="detail-title-group">
              <h2>
                {stash
                  ? "临时保存"
                  : (data?.detail.subject ?? subject ?? "无法读取提交")}
              </h2>
              {!stash && data && (
                <CopyButton
                  quiet
                  text={data.detail.subject}
                  label="复制提交标题"
                />
              )}
            </div>
            <button
              className="icon-button"
              onClick={onClose}
              title="关闭详情 · Esc"
              aria-label="关闭详情"
            >
              <Icon name="close" />
            </button>
          </header>
          {stash ? (
            <div className="stash-list">
              {project.snapshot.stashes.map((item) => (
                <div className="stash-item" key={item.reference}>
                  <code>{item.reference}</code>
                  <p>{item.subject}</p>
                </div>
              ))}
            </div>
          ) : (
            <>
              {data && (
                <div className="commit-context">
                  <p className="commit-author-line">
                    <strong>{data.detail.author}</strong>
                    <span>
                      {new Date(data.detail.date).toLocaleDateString("zh-CN")}
                    </span>
                  </p>
                  <p>
                    {data.detail.comparison} · {data.detail.files.length} 个文件
                  </p>
                  <CommitMetadata detail={data.detail} />
                </div>
              )}
              <ReadStatus
                busy={view.loading}
                requestKey={view.requestKey}
                label={
                  sameCommit
                    ? "正在更新差异…"
                    : `正在读取${subject ? "：" + subject : "提交"}…`
                }
              />
              {view.error && (
                <div className="detail-message error-text" role="status">
                  {data && "未更新，保留上次读取结果。"}
                  {data &&
                    !sameCommit &&
                    selection.kind === "commit" &&
                    `读取 ${selection.hash.slice(0, 8)} 失败，当前显示 ${data.detail.hash.slice(0, 8)} 的内容。`}
                  {view.error.message}
                  <button onClick={view.retry}>重试</button>
                </div>
              )}
              {data && (
                <>
                  <div className="file-list" aria-label="变更文件列表">
                    {!data.detail.files.length && (
                      <p className="detail-message">
                        相对比较基准没有文件变化。
                      </p>
                    )}
                    {data.detail.files.map((file) => (
                      <button
                        className={
                          "file-row " +
                          (data.filePath === file.path ? "active" : "")
                        }
                        key={file.path}
                        disabled={!sameCommit}
                        onClick={() => view.choose(file.path)}
                      >
                        <FileIcon path={file.path} />
                        <span className="file-name" title={file.path}>
                          {file.path}
                          {file.oldPath && (
                            <small>原路径：{file.oldPath}</small>
                          )}
                        </span>
                        <span className="file-status">
                          <span className="badge">
                            {(
                              {
                                A: "新增",
                                D: "删除",
                                M: "修改",
                                R: "重命名",
                                T: "类型变化",
                              } as Record<string, string>
                            )[file.status[0]] || file.status}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {data.filePath && (
                    <div className="diff-area">
                      <div className="diff-top">
                        <span className="diff-path" title={data.filePath}>
                          {data.filePath}
                        </span>
                        <CopyButton text={data.filePath} label="复制文件路径" />
                      </div>
                      <div className="diff-scroll">
                        {data.diff && (
                          <DiffView
                            data={data.diff}
                            active={shown}
                            origin={{
                              repoId: project.repoId,
                              path: data.filePath,
                              mode: "commit",
                              commit: data.detail.hash,
                              historyRevision: data.revision,
                            }}
                          />
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
