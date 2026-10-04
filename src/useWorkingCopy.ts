import { useEffect, useRef, useState } from "react";
import { request, errorOf } from "./api";
import type { Project, Diff, DiffMode, GitError, FileState } from "./types";
export type WorkingFile = { path: string; mode: DiffMode };
export function fileModes(file: FileState): DiffMode[] {
  return file.conflict
    ? ["conflict"]
    : file.untracked
      ? ["unstaged"]
      : [
          ...(file.unstaged ? ["unstaged" as const] : []),
          ...(file.staged ? ["staged" as const] : []),
        ];
}
function preferred(files: FileState[]): WorkingFile | null {
  const f =
    files.find((f) => f.conflict) ||
    files.find((f) => f.unstaged || f.untracked) ||
    files[0];
  return f ? { path: f.path, mode: fileModes(f)[0] } : null;
}
export function useWorkingCopy(project: Project | null, active: boolean) {
  const [selection, setSelection] = useState<{
    repoId: string;
    file: WorkingFile | null;
  } | null>(null);
  const [result, setResult] = useState<{
    key: string;
    data: Diff | null;
    error: GitError | null;
    loading: boolean;
  }>({ key: "", data: null, error: null, loading: false });
  const [retry, setRetry] = useState(0);
  const cache = useRef(new Map<string, Diff>());
  const files = project?.snapshot.files ?? [];
  const requested =
    selection?.repoId === project?.repoId ? selection?.file : null;
  const actual = files.find((f) => f.path === requested?.path);
  const file =
    actual && requested
      ? {
          path: actual.path,
          mode: fileModes(actual).includes(requested.mode)
            ? requested.mode
            : fileModes(actual)[0],
        }
      : preferred(files);
  useEffect(() => {
    if (
      project &&
      (!selection ||
        selection.repoId !== project.repoId ||
        !actual ||
        (requested && !fileModes(actual).includes(requested.mode)))
    ) {
      setSelection({
        repoId: project.repoId,
        file: actual
          ? { path: actual.path, mode: fileModes(actual)[0] }
          : preferred(files),
      });
    }
  }, [project?.repoId, project?.snapshot.changesRevision]);
  const key =
    project && file ? project.repoId + "\0" + file.path + "\0" + file.mode : "";
  const versionKey =
    key + "\0" + project?.snapshot.changesRevision + "\0" + retry;
  const cached = cache.current.get(versionKey);
  useEffect(() => {
    if (!active || !project || !file) return;
    const hit = cache.current.get(versionKey);
    if (hit) {
      setResult({ key, data: hit, error: null, loading: false });
      return;
    }
    let live = true;
    setResult((old) => ({
      key,
      data: old.key === key ? old.data : null,
      error: null,
      loading: true,
    }));
    request<Diff>("get_diff", {
      repoId: project.repoId,
      path: file.path,
      mode: file.mode,
      commit: null,
    })
      .then((data) => {
        if (live) {
          cache.current.set(versionKey, data);
          // 差异单次最多 240 KB；只保留最近 12 个比较范围，内存不会随文件数量增长。
          if (cache.current.size > 12)
            cache.current.delete(cache.current.keys().next().value!);
          setResult({ key, data, error: null, loading: false });
        }
      })
      .catch((e) => {
        if (live)
          setResult((old) => ({
            key,
            data: old.key === key ? old.data : null,
            error: errorOf(e),
            loading: false,
          }));
      });
    return () => {
      live = false;
    };
  }, [
    project?.repoId,
    file?.path,
    file?.mode,
    project?.snapshot.changesRevision,
    active,
    retry,
  ]);
  return {
    file,
    requestKey: versionKey,
    diff: cached ?? (result.key === key ? result.data : null),
    error: result.key === key ? result.error : null,
    loading: !cached && result.key === key && result.loading,
    choose: (value: WorkingFile) => {
      if (project) setSelection({ repoId: project.repoId, file: value });
    },
    retry: () => setRetry((n) => n + 1),
  };
}
