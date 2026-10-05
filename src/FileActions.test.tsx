// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { request } from "./api";
import { CopyButton } from "./CopyButton";
import { DiffView } from "./DiffView";
import { LineAttribution } from "./LineAttribution";
import { HistoryGraph } from "./HistoryGraph";
import type { Diff, LineOrigin, PreviewSide, Snapshot } from "./types";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("./api", () => ({
  request: vi.fn(),
  errorOf: (error: unknown) => error,
}));
beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.mocked(writeText).mockResolvedValue();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const base: Diff = {
  patch: "",
  truncated: false,
  binary: true,
  note: null,
  conflict: null,
};
const side: PreviewSide = {
  size: 64,
  kind: "image",
  mime: "image/png",
  dataUrl: "data:image/png;base64,AA==",
  width: 640,
  height: 360,
  hex: "00ff",
  hexTruncated: false,
  note: null,
};

it("图片显示真实双方、切换对比方式，新增文件不提供双图比较", () => {
  const view = render(
    <DiffView
      data={{
        ...base,
        preview: {
          before: side,
          after: { ...side, size: 128 },
          conflict: false,
        },
      }}
      labels={["暂存区", "工作区"]}
    />,
  );
  expect(screen.getByRole("img", { name: "暂存区" }).getAttribute("src")).toBe(
    side.dataUrl,
  );
  expect(screen.getByText(/640 × 360 · 128 B/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "复制文件对比信息" })).toBeNull();
  expect(screen.queryByText("字节差异")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "100%" }));
  expect(
    screen.getByRole("button", { name: "上下" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "适应" }));
  expect(
    screen.getByRole("button", { name: "并排" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "滑动" }));
  expect(screen.getByRole("slider", { name: "图片对比分界" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "叠加" }));
  fireEvent.change(screen.getByRole("slider", { name: "叠加不透明度" }), {
    target: { value: "25" },
  });
  expect(screen.getByRole("img", { name: "工作区" }).style.opacity).toBe(
    "0.25",
  );
  view.rerender(
    <DiffView
      data={{
        ...base,
        preview: { before: null, after: side, conflict: false },
      }}
    />,
  );
  expect(
    screen.getByRole("button", { name: "滑动" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("img", { name: "变更后" })).toBeTruthy();
});
it("未知二进制按真实偏移高亮变化，截断不能冒充没有差异", () => {
  render(
    <DiffView
      data={{
        ...base,
        preview: {
          before: {
            ...side,
            kind: "binary",
            dataUrl: null,
            hexTruncated: true,
          },
          after: { ...side, kind: "binary", dataUrl: null, hexTruncated: true },
          conflict: false,
        },
      }}
    />,
  );
  expect(
    screen.getByText("前 4 KiB 没有字节变化，后续内容未比较。"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "仅显示变化" }));
  expect(screen.getByText("00000000")).toBeTruthy();
});
it("图片解码失败时直接显示字节内容，不恢复折叠开关", () => {
  const view = render(
    <DiffView
      data={{
        ...base,
        preview: { before: side, after: side, conflict: false },
      }}
    />,
  );
  expect(screen.queryByText("字节差异")).toBeNull();
  fireEvent.error(screen.getByRole("img", { name: "变更后" }));
  expect(screen.getByRole("region", { name: "字节差异" })).toBeTruthy();
  expect(view.container.querySelector("summary")).toBeNull();
});
it("仅转编码的文件仍显示变化说明与字节对照", () => {
  render(
    <DiffView
      data={{
        ...base,
        encoding: "UTF-16 LE → UTF-8",
        note: "文本内容相同，编码或字节表示发生变化。",
        preview: {
          before: { ...side, kind: "binary", dataUrl: null, hex: "fffe4100" },
          after: { ...side, kind: "binary", dataUrl: null, hex: "41" },
          conflict: false,
        },
      }}
    />,
  );
  expect(screen.getByText(/UTF-16 LE → UTF-8/)).toBeTruthy();
  expect(screen.getByText(/文本内容相同/)).toBeTruthy();
  expect(screen.getByText("00000000")).toBeTruthy();
});
it("字节对照只挂载视口附近的偏移，滚动后显示对应真实字节", () => {
  const view = render(
    <DiffView
      data={{
        ...base,
        preview: {
          before: {
            ...side,
            kind: "binary",
            dataUrl: null,
            hex: "00".repeat(4096),
          },
          after: {
            ...side,
            kind: "binary",
            dataUrl: null,
            hex: "ff".repeat(4096),
          },
          conflict: false,
        },
      }}
    />,
  );
  expect(view.container.querySelectorAll(".hex-row").length).toBeLessThan(30);
  expect(screen.getByText("00000000")).toBeTruthy();
  const viewport = view.container.querySelector(".hex-viewport")!;
  fireEvent.scroll(viewport, { target: { scrollTop: 2400 } });
  expect(screen.queryByText("00000000")).toBeNull();
  expect(screen.getByText("00000640")).toBeTruthy();
  expect(view.container.querySelectorAll(".hex-row").length).toBeLessThan(30);
});
it("字节筛选变为空再恢复时，同步新视口的顶部偏移", () => {
  const binary: PreviewSide = {
    ...side,
    kind: "binary",
    dataUrl: null,
    hex: "00".repeat(4096),
    hexTruncated: true,
  };
  const view = render(
    <DiffView
      data={{
        ...base,
        preview: { before: binary, after: binary, conflict: false },
      }}
    />,
  );
  const filter = screen.getByRole("checkbox", { name: "仅显示变化" });
  fireEvent.click(filter);
  fireEvent.scroll(view.container.querySelector(".hex-viewport")!, {
    target: { scrollTop: 2400 },
  });
  expect(screen.getByText("00000640")).toBeTruthy();
  fireEvent.click(filter);
  expect(view.container.querySelector(".hex-viewport")).toBeNull();
  fireEvent.click(filter);
  expect(screen.getByText("00000000")).toBeTruthy();
  expect(view.container.querySelector(".hex-viewport")!.scrollTop).toBe(0);
});
it("换图后解码失败不能在新文件下保留旧像素画布", async () => {
  const images: Array<{ onload: () => void; onerror: () => void }> = [];
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1;
      naturalHeight = 1;
      onload = () => {};
      onerror = () => {};
      set src(_value: string) {
        images.push(this);
      }
    },
  );
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({
      clearRect() {},
      drawImage() {},
      putImageData() {},
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    } as unknown as CanvasRenderingContext2D);
  try {
    const view = render(
      <DiffView
        data={{
          ...base,
          preview: { before: side, after: side, conflict: false },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "像素差异" }));
    await act(async () => images.forEach((image) => image.onload()));
    expect(view.container.querySelector("canvas")!.width).toBe(1);
    expect(screen.getByText(/0.00% 像素变化/)).toBeTruthy();
    view.rerender(
      <DiffView
        data={{
          ...base,
          preview: {
            before: side,
            after: { ...side, dataUrl: "data:image/png;base64,BAD" },
            conflict: false,
          },
        }}
      />,
    );
    expect(view.container.querySelector("canvas")!.width).toBe(0);
    await act(async () => images.at(-1)!.onerror());
    expect(screen.getByText(/无法计算此格式的像素差异/)).toBeTruthy();
    expect(view.container.querySelector("canvas")!.width).toBe(0);
    expect(screen.getByRole("region", { name: "字节差异" })).toBeTruthy();
    view.rerender(
      <DiffView
        data={{
          ...base,
          preview: { before: side, after: side, conflict: false },
        }}
      />,
    );
    expect(screen.queryByRole("region", { name: "字节差异" })).toBeNull();
  } finally {
    context.mockRestore();
  }
});
it("复制结果确实来自原生剪贴板调用，失败保留重试，换对象忽略迟到成功", async () => {
  let resolve!: () => void;
  vi.mocked(writeText).mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const view = render(<CopyButton text="old" label="复制标题" />);
  fireEvent.click(screen.getByRole("button"));
  expect(writeText).toHaveBeenCalledWith("old");
  view.rerender(<CopyButton text="new" label="复制标题" />);
  await act(async () => resolve());
  expect(screen.queryByRole("status")).toBeNull();
  vi.mocked(writeText).mockRejectedValueOnce(new Error("denied"));
  await act(async () => fireEvent.click(screen.getByRole("button")));
  expect(screen.getByRole("status").textContent).toContain("复制失败");
  await act(async () => fireEvent.click(screen.getByRole("button")));
  expect(screen.getByRole("status").textContent).toBe("已复制");
  expect(writeText).toHaveBeenLastCalledWith("new");
});
it("行归属只接受当前文件与行号的响应", async () => {
  const requests: Array<(data: LineOrigin) => void> = [];
  vi.mocked(request).mockImplementation(
    () =>
      new Promise((resolve) =>
        requests.push(resolve as (data: LineOrigin) => void),
      ),
  );
  const origin = {
    repoId: "repo",
    path: "code.ts",
    mode: "unstaged" as const,
    changesRevision: "revision",
  };
  const view = render(
    <LineAttribution
      origin={origin}
      selection={{ side: "after", line: 2 }}
      onClose={() => {}}
      active
    />,
  );
  view.rerender(
    <LineAttribution
      origin={origin}
      selection={{ side: "before", line: 1 }}
      onClose={() => {}}
      active
    />,
  );
  const data: LineOrigin = {
    hash: "a".repeat(40),
    author: "Alice",
    email: "alice@example.invalid",
    timestamp: 123456,
    subject: "initial",
    originalLine: 1,
    line: 1,
    path: "code.ts",
  };
  await act(async () => {
    requests[1](data);
    requests[0]({ ...data, author: "Wrong owner" });
  });
  expect(screen.getByText("Alice")).toBeTruthy();
  expect(screen.queryByText("Wrong owner")).toBeNull();
  expect(request).toHaveBeenLastCalledWith("get_line_origin", {
    repoId: "repo",
    request: { ...origin, repoId: undefined, side: "before", line: 1 },
  });
});
it("提交树显示作者，复制标题与完整 ID 不选择提交", async () => {
  const commit = {
    hash: "a".repeat(40),
    author: "Alice",
    date: "2026-10-05T00:00:00Z",
    subject: "新增图片",
    parents: [],
  };
  const snapshot = {
    head: commit.hash,
    refs: [
      {
        name: "main",
        fullName: "refs/heads/main",
        hash: commit.hash,
        kind: "branch",
      },
    ],
  } as Snapshot;
  const onSelect = vi.fn();
  render(
    <HistoryGraph
      commits={[commit]}
      snapshot={snapshot}
      selected={null}
      onSelect={onSelect}
      locate={0}
      resetKey="repo"
    />,
  );
  expect(screen.getByText("Alice")).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "复制提交标题与 ID" })),
  );
  expect(writeText).toHaveBeenCalledWith(`${commit.subject}\n${commit.hash}`);
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "复制分支名称：main" })),
  );
  expect(writeText).toHaveBeenLastCalledWith("main");
  expect(onSelect).not.toHaveBeenCalled();
});
