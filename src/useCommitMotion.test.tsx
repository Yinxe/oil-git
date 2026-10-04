// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCommitMotion } from "./useCommitMotion";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("隐藏时中止动画，恢复与未知顺序不制造方向，减少动态效果直接到位", () => {
  let reduced = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return reduced;
    },
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  }));
  const original = Element.prototype.animate;
  const cancel = vi.fn();
  const animate = vi.fn<Element["animate"]>(
    () => ({ cancel }) as unknown as Animation,
  );
  Element.prototype.animate = animate;
  const commits = [{ hash: "a" }, { hash: "b" }, { hash: "c" }];
  function Harness({
    hash,
    active = true,
  }: {
    hash: string;
    active?: boolean;
  }) {
    const content = useCommitMotion(hash, commits, active);
    return <div ref={content}>{hash}</div>;
  }
  try {
    const { rerender, unmount } = render(<Harness hash="a" />);
    rerender(<Harness hash="b" />);
    expect(animate).toHaveBeenCalledTimes(1);
    rerender(<Harness hash="b" active={false} />);
    expect(cancel).toHaveBeenCalledTimes(1);
    rerender(<Harness hash="b" />);
    expect(animate).toHaveBeenCalledTimes(1);
    rerender(<Harness hash="c" />);
    expect(animate).toHaveBeenCalledTimes(2);
    reduced = true;
    act(() => listeners.forEach((listener) => listener()));
    expect(cancel).toHaveBeenCalledTimes(2);
    rerender(<Harness hash="a" />);
    expect(animate).toHaveBeenCalledTimes(2);
    reduced = false;
    rerender(<Harness hash="unloaded" />);
    rerender(<Harness hash="b" />);
    expect(animate).toHaveBeenCalledTimes(2);
    unmount();
    expect(listeners.size).toBe(0);
  } finally {
    Element.prototype.animate = original;
  }
});
