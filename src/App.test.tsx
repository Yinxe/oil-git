// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  cleanup,
} from "@testing-library/react";
import App from "./App";
import { request } from "./api";
import type { Project } from "./types";
vi.mock("./useRepository", () => ({ useRepository: () => repo }));
vi.mock("./api", async () => ({
  ...(await vi.importActual("./api")),
  request: vi.fn(),
}));
const sha = "a".repeat(40);
const project: Project = {
  repoId: "repo",
  snapshot: {
    path: "/fixture",
    name: "fixture",
    branch: "main",
    head: sha,
    refs: [],
    files: [
      {
        path: "file.txt",
        oldPath: null,
        xy: "MM",
        conflict: false,
        untracked: false,
        staged: true,
        unstaged: true,
      },
    ],
    historyRevision: "one",
    changesRevision: "one",
    upstream: null,
    ahead: 0,
    behind: 0,
    operation: null,
    worktrees: [],
    stashes: [],
  },
};
let repo: Record<string, any>;
let pending: { args: Record<string, unknown>; resolve: (v: unknown) => void }[];
beforeEach(() => {
  pending = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement, options?: ScrollToOptions | number) {
      if (typeof options === "object") this.scrollTop = options.top ?? 0;
    },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  repo = {
    project,
    recents: [],
    gitStatus: { loading: false, version: "git" },
    error: null,
    opening: false,
    refreshing: false,
    syncing: false,
    reference: "all",
    viewRequest: null,
    history: {
      commits: [
        {
          hash: sha,
          parents: [],
          subject: "真实提交",
          author: "测试",
          date: "2026-01-01",
        },
      ],
      snapshot: project.snapshot,
      reference: "all",
      requestedReference: "all",
      requestId: 1,
      hasMore: false,
      loading: false,
      error: null,
    },
    choose: vi.fn(),
    openPath: vi.fn(),
    refresh: vi.fn(),
    checkGit: vi.fn(),
    clearError: vi.fn(),
    retryError: vi.fn(),
    filter: vi.fn(),
    more: vi.fn(),
  };
  vi.mocked(request).mockImplementation(
    ((command: string, args?: Record<string, unknown>) =>
      new Promise<unknown>((resolve) =>
        pending.push({ args: args ?? {}, resolve }),
      )) as typeof request,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const resolve = async (index: number, text: string) =>
  act(async () =>
    pending[index].resolve({
      patch: "@@ -1 +1 @@\n-old\n+" + text,
      truncated: false,
      binary: false,
      note: null,
      conflict: null,
    }),
  );
describe("常驻侧栏与右侧视图", () => {
  it("同步保留提交内容并使用顶部进度，真正失败仍提示旧结果并可重试", () => {
    vi.useFakeTimers();
    repo.syncing = true;
    const view = render(<App />);
    act(() => vi.advanceTimersByTime(200));
    expect(
      screen.getByRole("progressbar", { name: "正在同步仓库" }),
    ).toBeTruthy();
    expect(screen.getByText("真实提交")).toBeTruthy();
    expect(document.querySelector(".error-banner")).toBeNull();
    repo.syncing = false;
    repo.error = { kind: "io", message: "目录无法读取" };
    view.rerender(<App />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/目录无法读取.*保留上次读取的结果/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(repo.retryError).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it("移除最近项目失败时保留菜单行，不打开项目并在菜单内提示", async () => {
    repo.recents = [{ path: "/other", name: "other" }];
    repo.forgetRecent = vi.fn().mockResolvedValue(false);
    repo.recentError = { kind: "io", message: "最近项目写入失败" };
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "fixture" }));
    const row = await screen.findByRole("option", { name: /other/ });
    const remove = screen.getByRole("button", {
      name: "从最近打开移除 other",
    });
    expect(row.contains(remove)).toBe(false);

    fireEvent.click(remove);

    await waitFor(() =>
      expect(repo.forgetRecent).toHaveBeenCalledWith("/other"),
    );
    expect(repo.openPath).not.toHaveBeenCalledWith("/other");
    expect(screen.getByRole("status").textContent).toBe("最近项目写入失败");
    expect(screen.getByRole("option", { name: /other/ })).toBeTruthy();
  });

  it("欢迎页的最近项目移除动作与打开动作分开", async () => {
    repo.project = null;
    repo.recents = [{ path: "/other", name: "other" }];
    repo.forgetRecent = vi.fn().mockResolvedValue(true);
    render(<App />);
    const open = document.querySelector(
      ".welcome-recent-open",
    ) as HTMLButtonElement;
    const remove = screen.getByRole("button", {
      name: "从最近打开移除 other",
    });
    expect(open.contains(remove)).toBe(false);

    fireEvent.click(remove);

    await waitFor(() =>
      expect(repo.forgetRecent).toHaveBeenCalledWith("/other"),
    );
    expect(repo.openPath).not.toHaveBeenCalledWith("/other");
  });

  it("选择文件切到源码，切回分支保留侧栏和历史滚动位置", async () => {
    const view = render(<App />);
    const sidebar = screen.getByLabelText("源代码管理文件列表");
    const graph = screen.getByLabelText(
      "提交历史，使用上下方向键选择，回车查看详情",
    );
    graph.scrollTop = 190;
    fireEvent.scroll(graph);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "file.txt · 未暂存" }));
    expect(
      screen.getByRole("tab", { name: "源码" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByLabelText("源代码管理文件列表")).toBe(sidebar);
    expect(pending[0].args.mode).toBe("unstaged");
    await resolve(0, "工作区内容");
    graph.scrollTop = 0;
    fireEvent.scroll(graph);
    fireEvent.click(screen.getByRole("tab", { name: "分支" }));
    expect(graph.scrollTop).toBe(190);
    expect(screen.getByLabelText("源代码管理文件列表")).toBe(sidebar);
    fireEvent.click(screen.getByRole("tab", { name: "源码" }));
    expect(sidebar.querySelector(".selected")?.getAttribute("title")).toBe(
      "file.txt",
    );
  });
  it("左右分组选择的过期差异不能覆盖最新范围", async () => {
    render(<App />);
    const rows = screen.getAllByRole("button", { name: /^file\.txt/ });
    fireEvent.click(rows[0]);
    expect(pending[0].args.mode).toBe("staged");
    fireEvent.click(rows[1]);
    expect(pending[1].args.mode).toBe("unstaged");
    await resolve(1, "最新工作区");
    await resolve(0, "旧暂存响应");
    expect(screen.getByText("+最新工作区")).toBeTruthy();
    expect(screen.queryByText("+旧暂存响应")).toBeNull();
  });
  it("源码里的返回 HEAD 会切换到分支视图", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "file.txt · 未暂存" }));
    fireEvent.click(screen.getByRole("button", { name: "返回 HEAD" }));
    expect(
      screen.getByRole("tab", { name: "分支" }).getAttribute("aria-selected"),
    ).toBe("true");
  });
  it("手动筛选会取消尚未完成的返回 HEAD 定位", async () => {
    repo.history.commits = [
      {
        hash: "c".repeat(40),
        parents: [],
        subject: "其他提交",
        author: "测试",
        date: "2026-01-01",
      },
    ];
    let nextRequestId = 1;
    repo.filter = vi.fn((reference: string) => {
      const requestId = ++nextRequestId;
      repo.history = {
        ...repo.history,
        requestedReference: reference,
        requestId,
        loading: true,
        error: null,
      };
      return requestId;
    });
    const view = render(<App />);
    const graph = screen.getByLabelText(
      "提交历史，使用上下方向键选择，回车查看详情",
    );
    const focus = vi.spyOn(graph, "focus");
    fireEvent.click(screen.getByRole("tab", { name: "源码" }));
    fireEvent.click(screen.getByRole("button", { name: "返回 HEAD" }));
    const locatedRequestId = repo.history.requestId;
    expect(repo.history.requestedReference).toBe("HEAD");

    fireEvent.click(screen.getByRole("button", { name: "筛选提交历史" }));
    const search = await screen.findByRole("textbox", {
      name: "搜索筛选提交历史",
    });
    fireEvent.change(search, { target: { value: "所有分支" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(repo.history.requestedReference).toBe("all");
    expect(repo.history.requestId).not.toBe(locatedRequestId);

    repo.history = {
      ...repo.history,
      commits: [{ ...repo.history.commits[0], hash: sha }],
      reference: "HEAD",
      requestedReference: "HEAD",
      requestId: locatedRequestId,
      loading: false,
      error: null,
      snapshot: project.snapshot,
    };
    view.rerender(<App />);
    expect(focus).not.toHaveBeenCalled();
  });
  it("HEAD 查询失败后，后续包含 HEAD 的结果不会执行过期定位", () => {
    repo.history.commits = [
      {
        hash: "c".repeat(40),
        parents: [],
        subject: "其他提交",
        author: "测试",
        date: "2026-01-01",
      },
    ];
    let nextRequestId = 1;
    repo.filter = vi.fn((reference: string) => {
      const requestId = ++nextRequestId;
      repo.history = {
        ...repo.history,
        requestedReference: reference,
        requestId,
        loading: true,
        error: null,
      };
      return requestId;
    });
    const view = render(<App />);
    const graph = screen.getByLabelText(
      "提交历史，使用上下方向键选择，回车查看详情",
    );
    const focus = vi.spyOn(graph, "focus");
    fireEvent.click(screen.getByRole("tab", { name: "源码" }));
    fireEvent.click(screen.getByRole("button", { name: "返回 HEAD" }));
    const failedRequestId = repo.history.requestId;
    repo.history = {
      ...repo.history,
      requestId: failedRequestId,
      loading: false,
      error: { kind: "timeout", message: "读取超时" },
    };
    view.rerender(<App />);
    repo.history = {
      ...repo.history,
      commits: [{ ...repo.history.commits[0], hash: sha }],
      reference: "all",
      requestedReference: "all",
      requestId: failedRequestId + 1,
      loading: false,
      error: null,
      snapshot: project.snapshot,
    };
    view.rerender(<App />);
    expect(focus).not.toHaveBeenCalled();
  });
  it("Escape 取消等待中的 HEAD 定位", () => {
    repo.history.commits = [
      {
        hash: "c".repeat(40),
        parents: [],
        subject: "其他提交",
        author: "测试",
        date: "2026-01-01",
      },
    ];
    let nextRequestId = 1;
    repo.filter = vi.fn((reference: string) => {
      const requestId = ++nextRequestId;
      repo.history = {
        ...repo.history,
        requestedReference: reference,
        requestId,
        loading: true,
        error: null,
      };
      return requestId;
    });
    const view = render(<App />);
    const graph = screen.getByLabelText(
      "提交历史，使用上下方向键选择，回车查看详情",
    );
    const focus = vi.spyOn(graph, "focus");
    fireEvent.click(screen.getByRole("tab", { name: "源码" }));
    fireEvent.click(screen.getByRole("button", { name: "返回 HEAD" }));
    const requestId = repo.history.requestId;
    fireEvent.keyDown(window, { key: "Escape" });
    repo.history = {
      ...repo.history,
      commits: [{ ...repo.history.commits[0], hash: sha }],
      reference: "HEAD",
      requestedReference: "HEAD",
      requestId,
      loading: false,
      error: null,
      snapshot: project.snapshot,
    };
    view.rerender(<App />);
    expect(focus).not.toHaveBeenCalled();
  });
  it("已经排队的返回 HEAD frame 在切换视图或仓库后失效", async () => {
    repo.recents = [{ path: "/other", name: "other" }];
    let nextFrame = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", cancel);
    render(<App />);
    const graph = screen.getByLabelText(
      "提交历史，使用上下方向键选择，回车查看详情",
    );
    const focus = vi.spyOn(graph, "focus");

    fireEvent.click(screen.getByRole("button", { name: "返回 HEAD" }));
    const afterViewChange = nextFrame;
    fireEvent.click(screen.getByRole("tab", { name: "源码" }));
    act(() => frames.get(afterViewChange)?.(performance.now()));
    expect(cancel).toHaveBeenCalledWith(afterViewChange);

    fireEvent.click(screen.getByRole("tab", { name: "分支" }));
    fireEvent.click(screen.getByRole("button", { name: "返回 HEAD" }));
    const afterRepoChange = nextFrame;
    fireEvent.click(screen.getByRole("button", { name: "fixture" }));
    fireEvent.click(await screen.findByRole("option", { name: /other/ }));
    act(() => frames.get(afterRepoChange)?.(performance.now()));
    expect(cancel).toHaveBeenCalledWith(afterRepoChange);
    expect(repo.openPath).toHaveBeenCalledWith("/other");
    expect(focus).not.toHaveBeenCalled();
  });
  it("相同版本的文件差异直接复用，外部修改后重新读取", async () => {
    const view = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "file.txt · 已暂存" }));
    await resolve(0, "暂存结果");
    fireEvent.click(screen.getByRole("button", { name: "file.txt · 未暂存" }));
    await resolve(1, "工作区结果");
    fireEvent.click(screen.getByRole("button", { name: "file.txt · 已暂存" }));
    expect(pending).toHaveLength(2);
    expect(screen.getByText("+暂存结果")).toBeTruthy();
    repo.project = {
      ...project,
      snapshot: { ...project.snapshot, changesRevision: "changed" },
    };
    view.rerender(<App />);
    expect(pending).toHaveLength(3);
    await resolve(2, "外部更新后的暂存结果");
    expect(screen.getByText("+外部更新后的暂存结果")).toBeTruthy();
  });
});
