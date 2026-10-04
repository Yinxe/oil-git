// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeDiff } from "./CodeDiff";
import { DiffView } from "./DiffView";

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  emit(entries: Array<{ target: Element; width: number; height: number }>) {
    this.callback(
      entries.map(
        ({ target, width, height }) =>
          ({
            target,
            contentRect: { width, height },
          }) as ResizeObserverEntry,
      ),
      this as unknown as ResizeObserver,
    );
  }
}

beforeEach(() => {
  localStorage.clear();
  TestResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId = 1;
    },
  );
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  TestResizeObserver.instances = [];
});

describe("CodeDiff 变高换行", () => {
  it("大差异只挂载当前视口附近的行", () => {
    const patch = [
      "@@ -1,5000 +1,5000 @@",
      ...Array.from({ length: 5_000 }, (_, index) => ` context ${index}`),
    ].join("\n");
    const { container } = render(
      <div className="diff-result">
        <CodeDiff patch={patch} layout="unified" />
      </div>,
    );

    expect(container.querySelectorAll(".virtual-code-row").length).toBeLessThan(
      40,
    );
  });

  it("大冲突只挂载可见原始行，保留真实行号与空行", () => {
    const lines = Array.from({ length: 10_000 }, (_, index) => ({
      line: 700 + index,
      text: index === 1 ? "" : `冲突代码 ${index}`,
    }));
    const { container } = render(
      <div className="diff-result">
        <DiffView
          data={{
            patch: "",
            truncated: false,
            binary: false,
            note: null,
            conflict: {
              kind: "内容冲突",
              note: null,
              blocks: [
                {
                  startLine: 700,
                  endLine: 10_699,
                  ours: lines,
                  base: [],
                  theirs: lines,
                  incoming: "feature",
                },
              ],
            },
          }}
        />
      </div>,
    );

    const viewports = Array.from(
      container.querySelectorAll<HTMLElement>(".raw-code-viewport"),
    );
    expect(viewports).toHaveLength(2);
    for (const viewport of viewports) {
      expect(
        viewport.querySelectorAll(".virtual-code-row").length,
      ).toBeLessThan(40);
      const firstRow = viewport.querySelector<HTMLElement>(
        '[data-virtual-index="0"].code-row',
      )!;
      expect(firstRow.querySelectorAll(".line-number")).toHaveLength(1);
      expect(firstRow.querySelector(".line-number")?.textContent).toBe("700");
      expect(firstRow.classList.contains("add")).toBe(false);
      expect(firstRow.classList.contains("remove")).toBe(false);
      expect(
        viewport.querySelector('[data-virtual-index="1"] .code-text')
          ?.textContent,
      ).toBe("");
    }
  });

  it("左右配对行共享实测最大高度，并在隐藏恢复时保留测量", () => {
    const { container, unmount } = render(
      <div className="diff-result">
        <CodeDiff patch={"@@ -8,1 +17,1 @@\n-old\n+new"} layout="split" />
      </div>,
    );
    const observer = TestResizeObserver.instances[0];
    const viewports = Array.from(
      container.querySelectorAll<HTMLElement>(".code-diff-viewport"),
    );
    const left = container.querySelector<HTMLElement>(
      '[data-virtual-index="1"][data-virtual-side="0"]',
    )!;
    const right = container.querySelector<HTMLElement>(
      '[data-virtual-index="1"][data-virtual-side="1"]',
    )!;

    expect(left.querySelector(".line-number")?.textContent).toBe("8");
    expect(right.querySelector(".line-number")?.textContent).toBe("17");
    act(() => {
      observer.emit([
        { target: viewports[0], width: 500, height: 300 },
        { target: viewports[1], width: 500, height: 300 },
      ]);
      observer.emit([
        { target: left, width: 200, height: 48 },
        { target: right, width: 200, height: 72 },
      ]);
    });
    expect(left.parentElement!.style.minHeight).toBe("72px");
    expect(right.parentElement!.style.minHeight).toBe("72px");

    act(() => {
      observer.emit([
        { target: viewports[0], width: 0, height: 0 },
        { target: viewports[1], width: 0, height: 0 },
      ]);
      observer.emit([
        { target: viewports[0], width: 500, height: 300 },
        { target: viewports[1], width: 500, height: 300 },
      ]);
    });
    expect(left.parentElement!.style.minHeight).toBe("72px");

    act(() => {
      observer.emit([{ target: viewports[0], width: 460, height: 300 }]);
    });
    expect(left.parentElement!.style.minHeight).toBe("24px");
    expect(right.parentElement!.style.minHeight).toBe("24px");

    unmount();
    expect(observer.disconnect).toHaveBeenCalled();
  });

  it("同批宽度和自然行高变化会立即更新，变宽可以缩回高度", () => {
    const { container } = render(
      <div className="diff-result">
        <CodeDiff patch={"@@ -1,1 +1,1 @@\n-old\n+new"} layout="split" />
      </div>,
    );
    const observer = TestResizeObserver.instances[0];
    const viewport = container.querySelector<HTMLElement>(
      ".code-diff-viewport",
    )!;
    const row = container.querySelector<HTMLElement>(
      '[data-virtual-index="1"][data-virtual-side="0"]',
    )!;
    act(() =>
      observer.emit([
        { target: viewport, width: 500, height: 300 },
        { target: row, width: 500, height: 48 },
      ]),
    );
    act(() =>
      observer.emit([
        { target: viewport, width: 300, height: 300 },
        { target: row, width: 300, height: 120 },
      ]),
    );
    expect(row.parentElement!.style.minHeight).toBe("120px");
    act(() =>
      observer.emit([
        { target: viewport, width: 600, height: 300 },
        { target: row, width: 600, height: 24 },
      ]),
    );
    expect(row.parentElement!.style.minHeight).toBe("24px");
  });

  it.each(["unified", "split"] as const)(
    "替换后重测复用的长行并保留下一行位置（%s）",
    (layout) => {
      const patchFor = (tail: string) =>
        `@@ -10,2 +20,2 @@\n ${"long text ".repeat(20)}\n ${tail}`;
      const { container, rerender } = render(
        <div className="diff-result">
          <CodeDiff patch={patchFor("tail")} layout={layout} />
        </div>,
      );
      const observer = TestResizeObserver.instances[0];
      const viewports = Array.from(
        container.querySelectorAll<HTMLElement>(".code-diff-viewport"),
      );
      const rowAt = (index: number, side: number) =>
        container.querySelector<HTMLElement>(
          `[data-virtual-index="${index}"][data-virtual-side="${side}"]`,
        )!;
      const topAt = (index: number, side: number) =>
        rowAt(index, side).parentElement!.style.top;
      const leftLong = rowAt(1, 0);
      const rightLong = layout === "split" ? rowAt(1, 1) : null;
      expect(leftLong.querySelectorAll(".line-number")[0]?.textContent).toBe(
        "10",
      );
      if (rightLong)
        expect(rightLong.querySelector(".line-number")?.textContent).toBe("20");
      act(() =>
        observer.emit([
          ...viewports.map((target) => ({
            target,
            width: 500,
            height: 300,
          })),
          { target: leftLong, width: 300, height: 96 },
          ...(rightLong ? [{ target: rightLong, width: 200, height: 72 }] : []),
        ]),
      );
      expect(topAt(2, 0)).toBe("120px");
      if (layout === "split") expect(topAt(2, 1)).toBe("120px");

      const observedBefore = observer.observe.mock.calls.filter(
        ([node]) => node === leftLong,
      ).length;
      const unobservedBefore = observer.unobserve.mock.calls.filter(
        ([node]) => node === leftLong,
      ).length;
      rerender(
        <div className="diff-result">
          <CodeDiff patch={patchFor("tail updated")} layout={layout} />
        </div>,
      );
      const reusedLeft = rowAt(1, 0);
      expect(reusedLeft).toBe(leftLong);
      expect(
        observer.unobserve.mock.calls.filter(([node]) => node === leftLong),
      ).toHaveLength(unobservedBefore + 1);
      expect(
        observer.observe.mock.calls.filter(([node]) => node === leftLong),
      ).toHaveLength(observedBefore + 1);
      expect(topAt(2, 0)).toBe("48px");
      if (layout === "split") expect(topAt(2, 1)).toBe("48px");

      act(() =>
        observer.emit([
          { target: reusedLeft, width: 300, height: 96 },
          ...(rightLong ? [{ target: rightLong, width: 200, height: 72 }] : []),
        ]),
      );
      expect(topAt(2, 0)).toBe("120px");
      if (layout === "split") expect(topAt(2, 1)).toBe("120px");
    },
  );

  it("拖动通过 RAF 更新比例，pointerup 保存，取消或失焦恢复", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
    const flushFrames = () => {
      const pending = [...frames.values()];
      frames.clear();
      act(() => pending.forEach((callback) => callback(0)));
    };
    let parentRenders = 0;
    function Harness() {
      parentRenders++;
      return (
        <div className="diff-result">
          <CodeDiff patch={"@@ -1,1 +1,1 @@\n-old\n+new"} layout="split" />
        </div>
      );
    }
    const { container } = render(<Harness />);
    const root = container.querySelector<HTMLElement>(".code-diff-split")!;
    Object.defineProperty(root, "clientWidth", {
      configurable: true,
      value: 1006,
    });
    const handle = screen.getByRole("separator", {
      name: "调整左右差异宽度",
    });

    expect(root.style.getPropertyValue("--diff-left-track")).toBe("0.5fr");
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 500,
    });
    expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(1);
    const startRenders = parentRenders;
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
    expect(root.style.getPropertyValue("--diff-left-track")).toBe("0.5fr");
    flushFrames();
    expect(root.style.getPropertyValue("--diff-left-track")).toBe("0.7fr");
    expect(parentRenders).toBe(startRenders);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(localStorage.getItem("oil-git.diff-split-ratio")).toBe("0.7");
    expect(handle.getAttribute("aria-valuenow")).toBe("70");

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 700,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1200 });
    flushFrames();
    expect(root.style.getPropertyValue("--diff-left-track")).toBe("0.75fr");
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(root.style.getPropertyValue("--diff-left-track")).toBe("0.7fr");
    expect(localStorage.getItem("oil-git.diff-split-ratio")).toBe("0.7");

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 700,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
    flushFrames();
    fireEvent.blur(window);
    expect(root.style.getPropertyValue("--diff-left-track")).toBe("0.7fr");
    expect(localStorage.getItem("oil-git.diff-split-ratio")).toBe("0.7");
  });

  it("分界可用键盘调整并限制在 25% 至 75%", () => {
    const { container } = render(
      <div className="diff-result">
        <CodeDiff patch={"@@ -1,1 +1,1 @@\n-old\n+new"} layout="split" />
      </div>,
    );
    const root = container.querySelector<HTMLElement>(".code-diff-split")!;
    const handle = screen.getByRole("separator", {
      name: "调整左右差异宽度",
    });

    fireEvent.keyDown(handle, { key: "Home" });
    expect(root.style.getPropertyValue("--diff-left-track")).toBe("0.25fr");
    expect(handle.getAttribute("aria-valuenow")).toBe("25");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(root.style.getPropertyValue("--diff-left-track")).toBe("0.27fr");
    fireEvent.keyDown(handle, { key: "End" });
    expect(root.style.getPropertyValue("--diff-left-track")).toBe("0.75fr");
    expect(localStorage.getItem("oil-git.diff-split-ratio")).toBe("0.75");
  });
});
