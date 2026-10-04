import { useEffect, useMemo, useState } from "react";
import { errorOf, request } from "./api";
import type { CommitDetail, Diff, GitError, Project, Selection } from "./types";

export type CommitView = {
  detail: CommitDetail;
  filePath: string | null;
  diff: Diff | null;
};
type Loaded = CommitView & { repoId: string; revision: string };

// 以仓库的有效历史版本为生命周期；同一请求复用 Promise，内容与内存均有上限。
class CommitCache {
  private entries = new Map<string, { data: CommitView; bytes: number }>();
  private pending = new Map<string, Promise<CommitView>>();
  private bytes = 0;
  constructor(
    private repoId: string,
    private revision: string,
  ) {}
  read(hash: string, path: string | null) {
    const key = hash + "\0" + (path ?? "");
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return Promise.resolve(cached.data);
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const load = request<CommitView>("get_commit_view", {
      repoId: this.repoId,
      commit: hash,
      path,
      expectedHistoryRevision: this.revision,
    }).then((data) => {
      const bytes = JSON.stringify(data).length * 2;
      if (bytes <= 6 * 1024 * 1024) {
        // 默认文件与其明确路径共享缓存，往返文件时不再重复读取。
        for (const alias of new Set([
          key,
          hash + "\0" + (data.filePath ?? ""),
        ])) {
          const old = this.entries.get(alias);
          this.bytes -= old?.bytes ?? 0;
          this.entries.delete(alias);
          this.entries.set(alias, { data, bytes });
          this.bytes += bytes;
        }
        while (this.entries.size > 12 || this.bytes > 6 * 1024 * 1024) {
          const oldest = this.entries.keys().next().value!;
          this.bytes -= this.entries.get(oldest)!.bytes;
          this.entries.delete(oldest);
        }
      }
      return data;
    });
    this.pending.set(key, load);
    void load.finally(() => this.pending.delete(key)).catch(() => {});
    return load;
  }
}

export function useCommitView(
  project: Project,
  selection: Selection,
  active: boolean,
) {
  const revision = project.snapshot.historyRevision;
  const cache = useMemo(
    () => new CommitCache(project.repoId, revision),
    [project.repoId, revision],
  );
  const hash = selection?.kind === "commit" ? selection.hash : null;
  const owner = project.repoId + "\0" + hash;
  const [choice, setChoice] = useState<{ owner: string; path: string } | null>(
    null,
  );
  const path = choice?.owner === owner ? choice.path : null;
  const [retry, setRetry] = useState(0);
  const key = [owner, revision, path ?? "", retry].join("\0");
  const [state, setState] = useState<{
    key: string;
    data: Loaded | null;
    loading: boolean;
    error: GitError | null;
  }>({ key: "", data: null, loading: false, error: null });
  const data = state.data?.repoId === project.repoId ? state.data : null;
  useEffect(() => {
    if (!active || !hash) return;
    let live = true;
    setState((old) => ({ ...old, key, loading: true, error: null }));
    void cache
      .read(hash, path)
      .catch((error: unknown) => {
        // replace 可以移除当前文件；同一提交换版本时改用该版本的默认文件。
        if (
          path &&
          data?.detail.hash === hash &&
          data.revision !== revision &&
          errorOf(error).kind === "invalid"
        )
          return cache.read(hash, null);
        throw error;
      })
      .then((view) => {
        if (live) {
          setState({
            key,
            data: { ...view, repoId: project.repoId, revision },
            loading: false,
            error: null,
          });
          if (path && view.filePath !== path)
            setChoice(view.filePath ? { owner, path: view.filePath } : null);
        }
      })
      .catch((error: unknown) => {
        if (live)
          setState((old) => ({
            ...old,
            key,
            loading: false,
            error: errorOf(error),
          }));
      });
    return () => {
      live = false;
    };
  }, [cache, hash, path, active, retry]);
  return {
    data,
    loading: !!hash && active && (state.key !== key || state.loading),
    error: state.key === key ? state.error : null,
    requestKey: key,
    choose: (file: string) => setChoice({ owner, path: file }),
    retry: () => setRetry((value) => value + 1),
  };
}
