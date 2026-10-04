// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  renderHook,
  render,
  act,
  waitFor,
  fireEvent,
  screen,
  cleanup,
} from "@testing-library/react";
import { useRepository } from "./useRepository";
import { ChangesSidebar, SourceEditor } from "./WorkingChanges";
import { useWorkingCopy } from "./useWorkingCopy";
import { Details } from "./Details";
import { request } from "./api";
import type { Snapshot, Project } from "./types";
vi.mock("./api", async () => ({
  ...(await vi.importActual("./api")),
  request: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
type Pending = {
  command: string;
  args: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (v: unknown) => void;
};
let queue: Pending[] = [];
const snapshot = (path: string): Snapshot => ({
  path,
  name: path,
  branch: "main",
  head: "a".repeat(40),
  refs: [],
  files: [],
  historyRevision: "one",
  changesRevision: "one",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
  worktrees: [],
  stashes: [],
});
const project = (path: string): Project => ({
  repoId: path,
  snapshot: snapshot(path),
});
const commitDetail = (hash: string, subject: string, paths = ["file.txt"]) => ({
  hash,
  parents: [],
  subject,
  author: "测试",
  date: "2026-01-01",
  comparison: "首次提交",
  files: paths.map((path) => ({ path, oldPath: null, status: "A" })),
});
const commitDiff = (content: string) => ({
  patch: "@@ -0,0 +1 @@\n+" + content,
  truncated: false,
  binary: false,
  note: null,
  conflict: null,
});
async function answer(pending: Pending, value: unknown) {
  await act(async () => {
    pending.resolve(value);
  });
}
async function fail(pending: Pending, error: unknown) {
  await act(async () => {
    pending.reject(error);
  });
}
function take(command: string) {
  const i = queue.findIndex((r) => r.command === command);
  expect(i).toBeGreaterThanOrEqual(0);
  return queue.splice(i, 1)[0];
}
function queueRecentReads() {
  const original = vi.mocked(request).getMockImplementation()!;
  vi.mocked(request).mockImplementation(((
    command: string,
    args?: Record<string, unknown>,
  ) =>
    command === "recent_repositories"
      ? new Promise<unknown>((resolve, reject) =>
          queue.push({ command, args: args ?? {}, resolve, reject }),
        )
      : original(command, args)) as typeof request);
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  queue = [];
  vi.mocked(request).mockImplementation(((
    command: string,
    args?: Record<string, unknown>,
  ) => {
    if (command === "check_git") return Promise.resolve("git version test");
    if (command === "recent_repositories") return Promise.resolve([]);
    if (command === "take_launch_request") return Promise.resolve(null);
    if (command === "activate_repository") return Promise.resolve(null);
    return new Promise<unknown>((resolve, reject) =>
      queue.push({ command, args: args ?? {}, resolve, reject }),
    );
  }) as typeof request);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe("真实组件的请求顺序", () => {
  it("移除后较早的打开响应不能恢复记录，主动重开可以加入", async () => {
    let stored = [{ path: "/slow", name: "slow" }];
    let completeOpen!: (value: Project) => void;
    let opens = 0;
    vi.mocked(request).mockImplementation(((
      command: string,
      args?: Record<string, unknown>,
    ) => {
      if (command === "check_git") return Promise.resolve("git version test");
      if (command === "take_launch_request") return Promise.resolve(null);
      if (command === "recent_repositories")
        return Promise.resolve([...stored]);
      if (command === "open_repository") {
        opens++;
        return opens === 1
          ? new Promise<Project>((resolve) => {
              completeOpen = resolve;
            })
          : Promise.resolve(project("/slow"));
      }
      if (command === "forget_recent_repository") {
        stored = stored.filter((entry) => entry.path !== args?.path);
        return Promise.resolve([...stored]);
      }
      if (command === "activate_repository") {
        if (args?.remember !== false)
          stored = [{ path: "/slow", name: "slow" }];
        return Promise.resolve(null);
      }
      if (command === "get_history")
        return Promise.resolve({
          commits: [],
          hasMore: false,
          revision: "one",
        });
      return Promise.resolve(null);
    }) as typeof request);
    const { result } = renderHook(() => useRepository());
    await waitFor(() => expect(opens).toBe(1));
    await act(async () => {
      await result.current.forgetRecent("/slow");
    });
    await act(async () => {
      completeOpen(project("/slow"));
    });
    await waitFor(() => expect(result.current.opening).toBe(false));
    expect(result.current.project?.snapshot.path).toBe("/slow");
    expect(result.current.recents).toEqual([]);
    expect(stored).toEqual([]);
    await act(async () => {
      await result.current.openPath("/slow");
    });
    await waitFor(() => expect(result.current.recents).toHaveLength(1));
    expect(stored).toEqual([{ path: "/slow", name: "slow" }]);
  });
  it("移除最近项目失败时保留条目并记录区域错误", async () => {
    queueRecentReads();
    const { result } = renderHook(() => useRepository());
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "recent_repositories"),
      ).toBe(true),
    );
    await answer(take("recent_repositories"), [
      { path: "/missing/project", name: "project" },
    ]);
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "open_repository"),
      ).toBe(true),
    );
    await answer(take("open_repository"), project("/missing/project"));
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "recent_repositories"),
      ).toBe(true),
    );
    await answer(take("recent_repositories"), [
      { path: "/missing/project", name: "project" },
    ]);
    await waitFor(() => expect(result.current.recents).toHaveLength(1));

    let removal!: Promise<boolean>;
    act(() => {
      removal = result.current.forgetRecent("/missing/project");
    });
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "forget_recent_repository"),
      ).toBe(true),
    );
    const pending = take("forget_recent_repository");
    expect(pending.args.path).toBe("/missing/project");
    await fail(pending, { kind: "io", message: "最近项目写入失败" });

    await expect(removal).resolves.toBe(false);
    expect(result.current.recents.map((recent) => recent.path)).toEqual([
      "/missing/project",
    ]);
    expect(result.current.recentError?.message).toBe("最近项目写入失败");
  });

  it("连续移除两条最近记录时按顺序写入并同步更新列表", async () => {
    queueRecentReads();
    const { result } = renderHook(() => useRepository());
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "recent_repositories"),
      ).toBe(true),
    );
    await answer(take("recent_repositories"), [
      { path: "/first", name: "first" },
      { path: "/second", name: "second" },
    ]);
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "open_repository"),
      ).toBe(true),
    );
    await answer(take("open_repository"), project("/first"));
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "recent_repositories"),
      ).toBe(true),
    );
    await answer(take("recent_repositories"), [
      { path: "/first", name: "first" },
      { path: "/second", name: "second" },
    ]);
    await waitFor(() => expect(result.current.recents).toHaveLength(2));

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.forgetRecent("/first");
      second = result.current.forgetRecent("/second");
    });
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "forget_recent_repository"),
      ).toBe(true),
    );
    const removeFirst = take("forget_recent_repository");
    expect(removeFirst.args.path).toBe("/first");
    await answer(removeFirst, [{ path: "/second", name: "second" }]);
    await waitFor(() => expect(result.current.recents).toHaveLength(1));
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "forget_recent_repository"),
      ).toBe(true),
    );
    const removeSecond = take("forget_recent_repository");
    expect(removeSecond.args.path).toBe("/second");
    await answer(removeSecond, []);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(result.current.recents).toEqual([]);
    expect(result.current.recentError).toBeNull();
  });

  it("移除当前仓库的最近记录不会关闭工作区", async () => {
    queueRecentReads();
    const { result } = renderHook(() => useRepository());
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "recent_repositories"),
      ).toBe(true),
    );
    await answer(take("recent_repositories"), []);
    act(() => {
      void result.current.openPath("/current");
    });
    await answer(take("open_repository"), project("/current"));
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "recent_repositories"),
      ).toBe(true),
    );
    await answer(take("recent_repositories"), [
      { path: "/current", name: "current" },
    ]);
    await waitFor(() => expect(result.current.recents).toHaveLength(1));

    let removal!: Promise<boolean>;
    act(() => {
      removal = result.current.forgetRecent("/current");
    });
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "forget_recent_repository"),
      ).toBe(true),
    );
    await answer(take("forget_recent_repository"), []);

    await expect(removal).resolves.toBe(true);
    expect(result.current.recents).toEqual([]);
    expect(result.current.project?.repoId).toBe("/current");
  });

  it("忽略移除期间迟到的最近列表响应，重新打开后仍可重新加入", async () => {
    queueRecentReads();
    const { result } = renderHook(() => useRepository());
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "recent_repositories"),
      ).toBe(true),
    );
    await answer(take("recent_repositories"), []);
    act(() => {
      void result.current.openPath("/removed");
    });
    await answer(take("open_repository"), project("/removed"));
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "recent_repositories"),
      ).toBe(true),
    );
    const staleRecents = take("recent_repositories");
    let removal!: Promise<boolean>;
    act(() => {
      removal = result.current.forgetRecent("/removed");
    });
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "forget_recent_repository"),
      ).toBe(true),
    );
    const forgetRequest = take("forget_recent_repository");

    act(() => {
      void result.current.openPath("/main");
    });
    await answer(take("open_repository"), project("/main"));
    await answer(forgetRequest, []);
    await expect(removal).resolves.toBe(true);
    await answer(staleRecents, [{ path: "/removed", name: "removed" }]);
    expect(result.current.project?.repoId).toBe("/main");
    expect(result.current.recents).toEqual([]);

    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "recent_repositories"),
      ).toBe(true),
    );
    await answer(take("recent_repositories"), [
      { path: "/main", name: "main" },
    ]);
    await waitFor(() =>
      expect(result.current.recents.map((recent) => recent.path)).toEqual([
        "/main",
      ]),
    );

    act(() => {
      void result.current.openPath("/removed");
    });
    await answer(take("open_repository"), project("/removed"));
    await waitFor(() =>
      expect(
        queue.some((request) => request.command === "recent_repositories"),
      ).toBe(true),
    );
    await answer(take("recent_repositories"), [
      { path: "/removed", name: "removed" },
      { path: "/main", name: "main" },
    ]);
    await waitFor(() =>
      expect(result.current.recents.map((recent) => recent.path)).toContain(
        "/removed",
      ),
    );
  });

  it("最近项目读取失败不改变已经成功打开的仓库", async () => {
    const { result } = renderHook(() => useRepository());
    await waitFor(() => expect(result.current.gitStatus.version).toBeTruthy());
    const original = vi.mocked(request).getMockImplementation()!;
    vi.mocked(request).mockImplementation(((
      command: string,
      args?: Record<string, unknown>,
    ) =>
      command === "recent_repositories"
        ? new Promise<unknown>((resolve, reject) =>
            queue.push({ command, args: args ?? {}, resolve, reject }),
          )
        : original(command, args)) as typeof request);
    act(() => {
      void result.current.openPath("main");
    });
    await answer(take("open_repository"), project("main"));
    await act(async () =>
      take("recent_repositories").reject({
        kind: "io",
        message: "列表读取失败",
      }),
    );
    expect(result.current.project?.repoId).toBe("main");
    expect(result.current.error).toBeNull();
    expect(result.current.opening).toBe(false);
  });
  it("打开失败由失败项目恢复，旧项目刷新不能清掉其错误", async () => {
    const { result } = renderHook(() => useRepository());
    await waitFor(() => expect(result.current.gitStatus.version).toBeTruthy());
    act(() => {
      void result.current.openPath("old");
    });
    await answer(take("open_repository"), project("old"));
    await answer(take("get_history"), {
      commits: [],
      hasMore: false,
      revision: "one",
    });
    act(() => {
      void result.current.openPath("missing", "changes");
    });
    await act(async () =>
      take("open_repository").reject({
        kind: "missing",
        message: "目录不存在",
      }),
    );
    act(() => {
      void result.current.refresh();
    });
    await answer(take("get_snapshot"), snapshot("old"));
    expect(result.current.project?.repoId).toBe("old");
    expect(result.current.error?.kind).toBe("missing");
    act(() => result.current.retryError());
    const retry = take("open_repository");
    expect(retry.args.path).toBe("missing");
    await answer(retry, project("missing"));
    expect(result.current.project?.repoId).toBe("missing");
    expect(result.current.error).toBeNull();
    expect(result.current.viewRequest?.view).toBe("changes");
  });
  it("新项目先返回时，旧项目不能覆盖它", async () => {
    const { result } = renderHook(() => useRepository());
    await waitFor(() => expect(result.current.gitStatus.version).toBeTruthy());
    act(() => {
      void result.current.openPath("old");
      void result.current.openPath("latest");
    });
    const old = take("open_repository"),
      latest = take("open_repository");
    await answer(latest, project("latest"));
    await answer(old, project("old"));
    expect(result.current.project?.repoId).toBe("latest");
    expect(
      vi
        .mocked(request)
        .mock.calls.filter(([command]) => command === "activate_repository")
        .map(([, args]) => args?.repoId),
    ).toEqual(["latest"]);
    await answer(take("get_history"), {
      commits: [],
      hasMore: false,
      revision: "one",
    });
  });
  it("快速筛选时只提交最后一次结果，失败保留旧历史", async () => {
    const { result } = renderHook(() => useRepository());
    await waitFor(() => expect(result.current.gitStatus.version).toBeTruthy());
    act(() => {
      void result.current.openPath("main");
    });
    await answer(take("open_repository"), project("main"));
    await answer(take("get_history"), {
      commits: [],
      hasMore: false,
      revision: "one",
    });
    act(() => {
      result.current.filter("HEAD");
      result.current.filter("all");
    });
    const old = take("get_history"),
      latest = take("get_history");
    const commit = {
      hash: "a",
      subject: "最新结果",
      parents: [],
      author: "测试",
      date: "2026-01-01",
    };
    await answer(latest, { commits: [commit], hasMore: true, revision: "one" });
    await answer(old, {
      commits: [{ ...commit, subject: "过期结果" }],
      hasMore: false,
      revision: "one",
    });
    expect(result.current.history.commits[0].subject).toBe("最新结果");
    act(() => result.current.filter("HEAD"));
    expect(result.current.reference).toBe("all");
    await act(async () =>
      take("get_history").reject({ kind: "timeout", message: "读取超时" }),
    );
    expect(result.current.history.commits[0].subject).toBe("最新结果");
    expect(result.current.history.error?.kind).toBe("timeout");
    expect(result.current.reference).toBe("all");
    expect(result.current.history.failedRequest?.reference).toBe("HEAD");
    const before = queue.length;
    act(() => result.current.more());
    expect(queue.length).toBe(before);
    act(() => result.current.retryHistory());
    expect(take("get_history").args.reference).toBe("HEAD");
  });
  it("历史更新失败时保留旧提交与绘图快照，成功后一起替换", async () => {
    const { result } = renderHook(() => useRepository());
    await waitFor(() => expect(result.current.gitStatus.version).toBeTruthy());
    act(() => void result.current.openPath("main"));
    await answer(take("open_repository"), project("main"));
    const oldHead = "a".repeat(40);
    await answer(take("get_history"), {
      commits: [
        {
          hash: oldHead,
          parents: [],
          subject: "旧历史",
          author: "测试",
          date: "2026-01-01",
        },
      ],
      hasMore: false,
      revision: "one",
    });
    const oldSnapshot = result.current.history.snapshot;
    expect(oldSnapshot?.head).toBe(oldHead);

    const newHead = "b".repeat(40);
    const updated = {
      ...snapshot("main"),
      head: newHead,
      historyRevision: "two",
      refs: [
        {
          name: "feature",
          fullName: "refs/heads/feature",
          hash: newHead,
          kind: "branch" as const,
        },
      ],
    };
    act(() => void result.current.refresh());
    await answer(take("get_snapshot"), updated);
    const failedUpdate = take("get_history");
    expect(failedUpdate.args.expected).toBe("two");
    expect(result.current.project?.snapshot.head).toBe(newHead);
    expect(result.current.history.commits[0].hash).toBe(oldHead);
    expect(result.current.history.snapshot).toBe(oldSnapshot);
    await act(async () =>
      failedUpdate.reject({ kind: "timeout", message: "历史读取超时" }),
    );
    expect(result.current.history.commits[0].hash).toBe(oldHead);
    expect(result.current.history.snapshot?.head).toBe(oldHead);
    expect(result.current.history.snapshot?.refs).toEqual([]);

    act(() => result.current.retryHistory());
    await answer(take("get_history"), {
      commits: [
        {
          hash: newHead,
          parents: [],
          subject: "新历史",
          author: "测试",
          date: "2026-01-02",
        },
      ],
      hasMore: false,
      revision: "two",
    });
    expect(result.current.history.commits[0].hash).toBe(newHead);
    expect(result.current.history.snapshot?.head).toBe(newHead);
    expect(result.current.history.snapshot?.refs).toEqual(updated.refs);
  });
  it("慢读取中的定时补查不排队，真实变化只合并补查一次", async () => {
    const { result } = renderHook(() => useRepository());
    await waitFor(() => expect(result.current.gitStatus.version).toBeTruthy());
    act(() => {
      void result.current.openPath("main");
    });
    await answer(take("open_repository"), project("main"));
    await answer(take("get_history"), {
      commits: [],
      hasMore: false,
      revision: "one",
    });
    act(() => {
      void result.current.refresh();
    });
    const first = take("get_snapshot");
    act(() => {
      void result.current.refresh(false, "poll");
      void result.current.refresh(false, "poll");
    });
    await answer(first, snapshot("main"));
    expect(queue.filter((p) => p.command === "get_snapshot")).toHaveLength(0);
    act(() => {
      void result.current.refresh();
    });
    const second = take("get_snapshot");
    act(() => {
      void result.current.refresh();
      void result.current.refresh();
    });
    await answer(second, snapshot("main"));
    expect(queue.filter((p) => p.command === "get_snapshot")).toHaveLength(1);
    await answer(take("get_snapshot"), snapshot("main"));
    expect(queue.filter((p) => p.command === "get_snapshot")).toHaveLength(0);
  });
  it("分页失败后重试原页，保留已经加载的历史", async () => {
    const { result } = renderHook(() => useRepository());
    await waitFor(() => expect(result.current.gitStatus.version).toBeTruthy());
    act(() => {
      void result.current.openPath("main");
    });
    await answer(take("open_repository"), project("main"));
    const page = (start: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        hash: String(start + i),
        parents: [],
        subject: "commit " + (start + i),
        author: "test",
        date: "2026-01-01",
      }));
    await answer(take("get_history"), {
      commits: page(0),
      hasMore: true,
      revision: "one",
    });
    act(() => result.current.more());
    await answer(take("get_history"), {
      commits: page(100),
      hasMore: true,
      revision: "one",
    });
    act(() => result.current.more());
    const third = take("get_history");
    expect(third.args.offset).toBe(200);
    await act(async () =>
      third.reject({ kind: "timeout", message: "读取超时" }),
    );
    expect(result.current.history.commits).toHaveLength(200);
    act(() => result.current.retryHistory());
    const retry = take("get_history");
    expect(retry.args.offset).toBe(200);
    await answer(retry, {
      commits: page(200),
      hasMore: false,
      revision: "one",
    });
    expect(result.current.history.commits).toHaveLength(300);
    expect(result.current.history.commits[0].hash).toBe("0");
  });
  it("启动时读取最近项目不能盖过用户主动打开的项目", async () => {
    vi.mocked(request).mockImplementation(((
      command: string,
      args?: Record<string, unknown>,
    ) => {
      if (command === "check_git") return Promise.resolve("git version test");
      if (command === "take_launch_request") return Promise.resolve(null);
      return new Promise<unknown>((resolve, reject) =>
        queue.push({ command, args: args ?? {}, resolve, reject }),
      );
    }) as typeof request);
    const { result } = renderHook(() => useRepository());
    await waitFor(() => expect(result.current.gitStatus.version).toBeTruthy());
    const recent = take("recent_repositories");
    act(() => {
      void result.current.openPath("chosen");
    });
    const chosen = take("open_repository");
    await answer(recent, [{ path: "recent", name: "recent" }]);
    expect(queue.some((r) => r.command === "open_repository")).toBe(false);
    await answer(chosen, project("chosen"));
    expect(result.current.project?.repoId).toBe("chosen");
  });
  it("详情中旧差异不会覆盖新范围，关闭后不能重新出现", async () => {
    const p = project("main");
    p.snapshot.files = [
      {
        path: "file.txt",
        oldPath: null,
        xy: "MM",
        untracked: false,
        conflict: false,
        staged: true,
        unstaged: true,
      },
    ];
    function Harness() {
      const w = useWorkingCopy(p, true);
      return (
        <>
          <ChangesSidebar
            files={p.snapshot.files}
            file={w.file}
            onFile={w.choose}
          />
          <SourceEditor
            files={p.snapshot.files}
            file={w.file}
            diff={w.diff}
            error={w.error}
            retry={w.retry}
          />
        </>
      );
    }
    const { unmount } = render(<Harness />);
    const old = take("get_diff");
    fireEvent.click(screen.getAllByRole("button", { name: /file.txt/ })[0]);
    const latest = take("get_diff");
    const diff = {
      patch: "@@ -1 +1 @@\n-old\n+已暂存的真实内容",
      truncated: false,
      binary: false,
      note: null,
      conflict: null,
    };
    await answer(latest, diff);
    await answer(old, { ...diff, patch: "过期的工作区内容" });
    expect(screen.getByText("+已暂存的真实内容")).toBeTruthy();
    expect(screen.queryByText("过期的工作区内容")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /file.txt/ })[1]);
    const closed = take("get_diff");
    unmount();
    await answer(closed, diff);
    expect(screen.queryByText("+已暂存的真实内容")).toBeNull();
  });
  const combined = (
    hash: string,
    subject: string,
    content: string,
    filePath = "first.txt",
  ) => ({
    detail: commitDetail(hash, subject, ["first.txt", "second.txt"]),
    filePath,
    diff: commitDiff(content),
  });
  it("提交一次读取后整体显示，未返回前没有占位标题", async () => {
    const p = project("main"),
      selection = { kind: "commit" as const, hash: p.snapshot.head! };
    render(<Details project={p} selection={selection} onClose={() => {}} />);
    const read = take("get_commit_view");
    expect(read.args.expectedHistoryRevision).toBe("one");
    expect(read.args.path).toBeNull();
    expect(screen.queryByText("提交详情")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    await answer(read, combined(selection.hash, "真实提交", "真实差异"));
    expect(screen.getByText("真实提交")).toBeTruthy();
    expect(screen.getByText("+真实差异")).toBeTruthy();
    expect(queue).toHaveLength(0);
  });
  it("文件与视图往返复用完整结果，保留差异浏览位置", async () => {
    const p = project("main"),
      selection = { kind: "commit" as const, hash: p.snapshot.head! };
    const { rerender } = render(
      <Details project={p} selection={selection} onClose={() => {}} />,
    );
    await answer(
      take("get_commit_view"),
      combined(selection.hash, "提交", "第一个文件"),
    );
    const viewport = screen.getByLabelText("统一代码差异");
    viewport.scrollTop = 120;
    fireEvent.click(screen.getByRole("button", { name: "提交信息" }));
    fireEvent.click(screen.getByRole("button", { name: /second.txt/ }));
    const second = take("get_commit_view");
    expect(second.args.path).toBe("second.txt");
    expect(screen.getByLabelText("统一代码差异")).toBe(viewport);
    expect(screen.getByText("+第一个文件")).toBeTruthy();
    await answer(
      second,
      combined(selection.hash, "提交", "第二个文件", "second.txt"),
    );
    expect(screen.getByLabelText("统一代码差异")).toBe(viewport);
    expect(viewport.scrollTop).toBe(0);
    expect(
      screen
        .getByRole("button", { name: "提交信息" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    viewport.scrollTop = 120;
    rerender(
      <Details
        project={p}
        selection={selection}
        active={false}
        onClose={() => {}}
      />,
    );
    rerender(
      <Details
        project={p}
        selection={selection}
        active={true}
        onClose={() => {}}
      />,
    );
    await act(async () => {});
    expect(queue).toHaveLength(0);
    expect(screen.getByLabelText("统一代码差异")).toBe(viewport);
    expect(viewport.scrollTop).toBe(120);
    fireEvent.click(screen.getByRole("button", { name: /first.txt/ }));
    await act(async () => {});
    expect(queue).toHaveLength(0);
    expect(screen.getByText("+第一个文件")).toBeTruthy();
    expect(screen.getByLabelText("统一代码差异")).toBe(viewport);
  });
  it("新文件未完成时保留旧路径，延迟提示并拒绝迟到覆盖", async () => {
    vi.useFakeTimers();
    const p = project("main"),
      selection = { kind: "commit" as const, hash: p.snapshot.head! };
    const { container } = render(
      <Details project={p} selection={selection} onClose={() => {}} />,
    );
    await answer(
      take("get_commit_view"),
      combined(selection.hash, "提交", "首个文件"),
    );
    fireEvent.click(screen.getByRole("button", { name: /second.txt/ }));
    const second = take("get_commit_view");
    expect(container.querySelector(".diff-path")?.textContent).toBe(
      "first.txt",
    );
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("status").textContent).toContain("正在更新");
    fireEvent.click(screen.getByRole("button", { name: /first.txt/ }));
    await act(async () => {});
    await answer(
      second,
      combined(selection.hash, "提交", "第二个文件", "second.txt"),
    );
    expect(screen.getByText("+首个文件")).toBeTruthy();
    expect(screen.queryByText("+第二个文件")).toBeNull();
    expect(container.querySelector(".diff-path")?.textContent).toBe(
      "first.txt",
    );
  });
  it("换版本保留文件选择，失败保留整组旧结果并可重试", async () => {
    const p = project("main"),
      selection = { kind: "commit" as const, hash: p.snapshot.head! };
    const { rerender } = render(
      <Details project={p} selection={selection} onClose={() => {}} />,
    );
    await answer(
      take("get_commit_view"),
      combined(selection.hash, "旧标题", "旧文件"),
    );
    fireEvent.click(screen.getByRole("button", { name: /second.txt/ }));
    await answer(
      take("get_commit_view"),
      combined(selection.hash, "旧标题", "旧第二个文件", "second.txt"),
    );
    const next = { ...p, snapshot: { ...p.snapshot, historyRevision: "two" } };
    rerender(
      <Details project={next} selection={selection} onClose={() => {}} />,
    );
    const update = take("get_commit_view");
    expect(update.args.path).toBe("second.txt");
    expect(update.args.expectedHistoryRevision).toBe("two");
    await fail(update, { kind: "io", message: "读取失败" });
    expect(screen.getByText("旧标题")).toBeTruthy();
    expect(screen.getByText("+旧第二个文件")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("保留上次");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await answer(
      take("get_commit_view"),
      combined(selection.hash, "新标题", "新第二个文件", "second.txt"),
    );
    expect(screen.getByText("新标题")).toBeTruthy();
    expect(screen.getByText("+新第二个文件")).toBeTruthy();
  });
  it("旧版本与旧项目响应不能覆盖新内容", async () => {
    const p = project("main"),
      selection = { kind: "commit" as const, hash: p.snapshot.head! };
    const { rerender, unmount } = render(
      <Details project={p} selection={selection} onClose={() => {}} />,
    );
    const old = take("get_commit_view");
    const next = { ...p, snapshot: { ...p.snapshot, historyRevision: "two" } };
    rerender(
      <Details project={next} selection={selection} onClose={() => {}} />,
    );
    const latest = take("get_commit_view");
    await answer(latest, combined(selection.hash, "新标题", "新内容"));
    await answer(old, combined(selection.hash, "旧标题", "旧内容"));
    expect(screen.getByText("新标题")).toBeTruthy();
    expect(screen.queryByText("旧标题")).toBeNull();
    rerender(
      <Details
        project={project("other")}
        selection={selection}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText("新标题")).toBeNull();
    const closed = take("get_commit_view");
    unmount();
    await answer(closed, combined(selection.hash, "关闭后的响应", "无效"));
    expect(screen.queryByText("关闭后的响应")).toBeNull();
  });
  it("同一提交换版本移除所选文件时，回退该版本默认文件", async () => {
    const p = project("main"),
      selection = { kind: "commit" as const, hash: p.snapshot.head! };
    const { rerender } = render(
      <Details project={p} selection={selection} onClose={() => {}} />,
    );
    await answer(take("get_commit_view"), combined(selection.hash, "旧", "一"));
    fireEvent.click(screen.getByRole("button", { name: /second.txt/ }));
    await answer(
      take("get_commit_view"),
      combined(selection.hash, "旧", "二", "second.txt"),
    );
    rerender(
      <Details
        project={{ ...p, snapshot: { ...p.snapshot, historyRevision: "two" } }}
        selection={selection}
        onClose={() => {}}
      />,
    );
    await fail(take("get_commit_view"), {
      kind: "invalid",
      message: "不属于此提交",
    });
    const fallback = take("get_commit_view");
    expect(fallback.args.path).toBeNull();
    await answer(fallback, combined(selection.hash, "新", "默认"));
    expect(screen.getByText("+默认")).toBeTruthy();
    expect(queue).toHaveLength(0);
  });
  it("跨提交失败时明确指出保留的是哪一提交", async () => {
    const p = project("main"),
      first = { kind: "commit" as const, hash: p.snapshot.head! },
      second = { kind: "commit" as const, hash: "b".repeat(40) };
    const { rerender } = render(
      <Details project={p} selection={first} onClose={() => {}} />,
    );
    await answer(
      take("get_commit_view"),
      combined(first.hash, "提交 A", "内容 A"),
    );
    rerender(
      <Details
        project={p}
        selection={second}
        subject="提交 B"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /first.txt/ })).toHaveProperty(
      "disabled",
      true,
    );
    await fail(take("get_commit_view"), { kind: "io", message: "读取失败" });
    expect(screen.getByRole("status").textContent).toContain(
      "读取 bbbbbbbb 失败，当前显示 aaaaaaaa",
    );
    expect(screen.getByText("提交 A")).toBeTruthy();
    expect(screen.getByText("+内容 A")).toBeTruthy();
  });
  it("旧打开请求的最近项目列表不能覆盖最新列表", async () => {
    const { result } = renderHook(() => useRepository());
    await waitFor(() => expect(result.current.gitStatus.version).toBeTruthy());
    vi.mocked(request).mockImplementation(((
      command: string,
      args?: Record<string, unknown>,
    ) => {
      if (command === "activate_repository") return Promise.resolve(null);
      return new Promise<unknown>((resolve, reject) =>
        queue.push({ command, args: args ?? {}, resolve, reject }),
      );
    }) as typeof request);
    act(() => {
      void result.current.openPath("a");
    });
    await answer(take("open_repository"), project("a"));
    const oldRecent = take("recent_repositories");
    act(() => {
      void result.current.openPath("b");
    });
    await answer(take("open_repository"), project("b"));
    const newRecent = take("recent_repositories");
    await answer(newRecent, [
      { path: "b", name: "b" },
      { path: "a", name: "a" },
    ]);
    await answer(oldRecent, [{ path: "a", name: "a" }]);
    expect(result.current.project?.repoId).toBe("b");
    expect(result.current.recents[0].path).toBe("b");
  });
});
