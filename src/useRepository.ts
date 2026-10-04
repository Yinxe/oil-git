import { useState, useRef, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { request, errorOf, RequestGate } from "./api";
import type { Project, Snapshot, Commit, HistoryPage, GitError } from "./types";
type Recent = { path: string; name: string };
type Launch = { path: string; view: "changes" | "history" };
type History = {
  commits: Commit[];
  snapshot: Snapshot | null;
  reference: string;
  requestedReference: string;
  requestId: number;
  revision: string;
  hasMore: boolean;
  loading: boolean;
  error: GitError | null;
  failedRequest: { reference: string; append: boolean } | null;
};
const empty: History = {
  commits: [],
  snapshot: null,
  reference: "all",
  requestedReference: "all",
  requestId: 0,
  revision: "",
  hasMore: false,
  loading: false,
  error: null,
  failedRequest: null,
};

export function useRepository() {
  const [project, setProject] = useState<Project | null>(null);
  const [recents, setRecents] = useState<Recent[]>([]);
  const [recentError, setRecentError] = useState<GitError | null>(null);
  const [forgettingRecent, setForgettingRecent] = useState(false);
  const [gitStatus, setGitStatus] = useState<{
    loading: boolean;
    version?: string;
    error?: GitError;
  }>({ loading: true });
  const [openError, setOpenError] = useState<GitError | null>(null);
  const [snapshotError, setSnapshotError] = useState<GitError | null>(null);
  const failedOpen = useRef<{ path: string; view?: string } | null>(null);
  const [opening, setOpening] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [history, setHistory] = useState<History>(empty);
  const [reference, setReference] = useState("all");
  const [viewRequest, setViewRequest] = useState<{
    repoId: string;
    view: string;
    serial: number;
  } | null>(null);
  const current = useRef<Project | null>(null),
    historyRef = useRef(empty),
    desired = useRef("all");
  const openGate = useRef(new RequestGate()),
    stateGate = useRef(new RequestGate()),
    historyGate = useRef(new RequestGate());
  const recentRevision = useRef(0),
    recentAction = useRef(0),
    recentWriteQueue = useRef<Promise<void>>(Promise.resolve()),
    pendingRecentWrites = useRef(0);
  const recentOpenIntent = useRef(new Set<string>());
  const flight = useRef<string | null>(null),
    refreshAgain = useRef(false);
  const hasOpenIntent = useRef(false);
  const gitReady = useRef(false);
  const setHistoryValue = (value: History) => {
    historyRef.current = value;
    setHistory(value);
  };
  const loadHistory = useCallback(
    async (
      ref: string,
      append = false,
      target = current.current,
      requestId = historyGate.current.next(),
    ) => {
      if (!target) return;
      desired.current = ref;
      const previous = historyRef.current;
      const offset = append ? previous.commits.length : 0;
      setHistoryValue({
        ...previous,
        requestedReference: ref,
        requestId,
        loading: true,
        error: null,
        failedRequest: null,
      });
      try {
        const page = await request<HistoryPage>("get_history", {
          repoId: target.repoId,
          reference: ref,
          offset,
          expected: target.snapshot.historyRevision,
        });
        if (
          !historyGate.current.accepts(requestId) ||
          current.current?.repoId !== target.repoId
        )
          return;
        setReference(ref);
        setHistoryValue({
          commits: append
            ? [...previous.commits, ...page.commits]
            : page.commits,
          snapshot: target.snapshot,
          reference: ref,
          requestedReference: ref,
          requestId,
          revision: page.revision,
          hasMore: page.hasMore,
          loading: false,
          error: null,
          failedRequest: null,
        });
      } catch (e) {
        if (
          !historyGate.current.accepts(requestId) ||
          current.current?.repoId !== target.repoId
        )
          return;
        desired.current = previous.reference;
        setReference(previous.reference);
        setHistoryValue({
          ...previous,
          requestedReference: ref,
          requestId,
          loading: false,
          error: errorOf(e),
          failedRequest: { reference: ref, append },
        });
      }
    },
    [],
  );
  const refresh = useCallback(
    async (showBusy = false, reason: "change" | "poll" = "change") => {
      const target = current.current;
      if (!target) return;
      if (flight.current === target.repoId) {
        if (reason !== "poll") refreshAgain.current = true;
        return;
      }
      flight.current = target.repoId;
      const ticket = stateGate.current.next();
      if (showBusy) setRefreshing(true);
      try {
        const snapshot = await request<Snapshot>("get_snapshot", {
          repoId: target.repoId,
        });
        if (
          !stateGate.current.accepts(ticket) ||
          current.current?.repoId !== target.repoId
        )
          return;
        const changed =
          target.snapshot.historyRevision !== snapshot.historyRevision;
        const next = { repoId: target.repoId, snapshot };
        current.current = next;
        setProject(next);
        setSnapshotError(null);
        if (
          !changed &&
          historyRef.current.snapshot?.historyRevision ===
            snapshot.historyRevision
        )
          setHistoryValue({ ...historyRef.current, snapshot });
        const valid =
          desired.current === "all" ||
          desired.current === "HEAD" ||
          snapshot.refs.some((r) => r.fullName === desired.current);
        if (
          changed ||
          !valid ||
          historyRef.current.error?.kind === "staleHistory"
        )
          void loadHistory(valid ? desired.current : "all", false, next);
      } catch (e) {
        if (stateGate.current.accepts(ticket)) setSnapshotError(errorOf(e));
      } finally {
        if (stateGate.current.accepts(ticket)) {
          flight.current = null;
          setRefreshing(false);
          if (refreshAgain.current) {
            refreshAgain.current = false;
            void refresh();
          }
        }
      }
    },
    [loadHistory],
  );
  const openPath = useCallback(
    async (path: string, view?: string) => {
      hasOpenIntent.current = true;
      setRecentError(null);
      const forgottenForThisOpen = new Set<string>();
      recentOpenIntent.current = forgottenForThisOpen;
      const ticket = openGate.current.next();
      setOpening(true);
      failedOpen.current = { path, view };
      setOpenError(null);
      try {
        const next = await request<Project>("open_repository", { path });
        if (!openGate.current.accepts(ticket)) return;
        stateGate.current.invalidate();
        historyGate.current.invalidate();
        flight.current = null;
        refreshAgain.current = false;
        setRefreshing(false);
        current.current = next;
        setProject(next);
        failedOpen.current = null;
        setSnapshotError(null);
        desired.current = "all";
        setReference("all");
        setHistoryValue(empty);
        setViewRequest(
          view ? { repoId: next.repoId, view, serial: ticket } : null,
        );
        void loadHistory("all", false, next);
        const activation = recentWriteQueue.current.then(() =>
          request("activate_repository", {
            repoId: next.repoId,
            remember: !forgottenForThisOpen.has(next.snapshot.path),
          }),
        );
        recentWriteQueue.current = activation.then(
          () => undefined,
          () => undefined,
        );
        void activation
          .catch(() => {
            /* 定时补查仍然有效。 */
          })
          .then(() => {
            const revision = recentRevision.current;
            return request<Recent[]>("recent_repositories").then((recent) => {
              if (
                openGate.current.accepts(ticket) &&
                revision === recentRevision.current
              )
                setRecents(recent);
            });
          })
          .catch(() => {
            /* 最近项目未更新时保留列表；仓库本身已经成功打开。 */
          });
      } catch (e) {
        if (openGate.current.accepts(ticket)) setOpenError(errorOf(e));
      } finally {
        if (openGate.current.accepts(ticket)) setOpening(false);
      }
    },
    [loadHistory],
  );
  const forgetRecent = useCallback(async (path: string) => {
    if (!path.trim()) {
      setRecentError({ kind: "path", message: "最近项目路径无效。" });
      return false;
    }
    hasOpenIntent.current = true;
    const action = ++recentAction.current;
    const openedBeforeRemoval = recentOpenIntent.current;
    setRecentError(null);
    pendingRecentWrites.current++;
    setForgettingRecent(true);

    const operation = recentWriteQueue.current.then(() =>
      request<Recent[]>("forget_recent_repository", { path }),
    );
    recentWriteQueue.current = operation.then(
      () => undefined,
      () => undefined,
    );
    try {
      const recent = await operation;
      openedBeforeRemoval.add(path);
      recentRevision.current++;
      setRecents(recent);
      if (action === recentAction.current) setRecentError(null);
      return true;
    } catch (error) {
      if (action === recentAction.current) setRecentError(errorOf(error));
      return false;
    } finally {
      pendingRecentWrites.current--;
      setForgettingRecent(pendingRecentWrites.current > 0);
    }
  }, []);
  const choose = useCallback(async () => {
    hasOpenIntent.current = true;
    setRecentError(null);
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "打开 Git 项目",
      });
      if (typeof path === "string") await openPath(path);
    } catch (e) {
      failedOpen.current = null;
      setOpenError(errorOf(e));
    }
  }, [openPath]);
  const checkGit = useCallback(async () => {
    setGitStatus({ loading: true });
    try {
      const version = await request<string>("check_git");
      gitReady.current = true;
      setGitStatus({ loading: false, version });
      const launch = await request<Launch | null>("take_launch_request");
      const revision = recentRevision.current;
      const recent = await request<Recent[]>("recent_repositories");
      if (!hasOpenIntent.current && revision === recentRevision.current)
        setRecents(recent);
      if (!current.current && !hasOpenIntent.current) {
        if (launch) void openPath(launch.path, launch.view);
        else if (recent[0]) void openPath(recent[0].path);
      }
    } catch (e) {
      setGitStatus({ loading: false, error: errorOf(e) });
    }
  }, [openPath]);
  useEffect(() => {
    void checkGit();
    return () => {
      openGate.current.invalidate();
      stateGate.current.invalidate();
      historyGate.current.invalidate();
    };
  }, [checkGit]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Agent 常在其他窗口修改项目；可见的观察窗口仍接收真实变化通知。
    listen<string>("repository-invalidated", (e) => {
      if (
        document.visibilityState === "visible" &&
        e.payload === current.current?.repoId
      )
        void refresh();
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus())
        void refresh(false, "poll");
    }, 3000);
    const focus = () => {
      if (document.visibilityState === "visible" && document.hasFocus())
        void refresh();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      disposed = true;
      unlisten?.();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [refresh]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<Launch>("open-request", (e) => {
      if (gitReady.current) {
        void request("take_launch_request");
        void openPath(e.payload.path, e.payload.view);
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPath]);
  return {
    project,
    recents,
    recentError,
    forgettingRecent,
    gitStatus,
    error: openError ?? snapshotError,
    opening,
    refreshing,
    history,
    reference,
    viewRequest,
    choose,
    openPath,
    forgetRecent,
    refresh,
    checkGit,
    retryError: () => {
      if (openError) {
        const target = failedOpen.current;
        if (target) void openPath(target.path, target.view);
        else void choose();
      } else void refresh(true);
    },
    filter: (ref: string) => {
      const requestId = historyGate.current.next();
      void loadHistory(ref, false, current.current, requestId);
      return requestId;
    },
    retryHistory: () => {
      const view = historyRef.current;
      void loadHistory(
        view.failedRequest?.reference ?? view.reference,
        view.failedRequest?.append ?? false,
      );
    },
    more: () => {
      const view = historyRef.current;
      if (
        !view.loading &&
        !view.error &&
        view.hasMore &&
        view.reference === desired.current
      )
        void loadHistory(view.reference, true);
    },
  };
}
