// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ReadStatus } from "./ReadStatus";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("快速完成的读取不闪现占位，慢读取就近提示且随请求切换清除", () => {
  vi.useFakeTimers();
  const view = render(
    <ReadStatus busy requestKey="first" label="正在读取差异…" />,
  );
  act(() => vi.advanceTimersByTime(100));
  view.rerender(
    <ReadStatus busy={false} requestKey="first" label="正在读取差异…" />,
  );
  act(() => vi.advanceTimersByTime(300));
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(<ReadStatus busy requestKey="second" label="正在读取差异…" />);
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole("status").textContent).toBe("正在读取差异…");
  view.rerender(<ReadStatus busy requestKey="third" label="正在读取差异…" />);
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(
    <ReadStatus busy={false} requestKey="third" label="正在读取差异…" />,
  );
  act(() => vi.advanceTimersByTime(300));
  expect(screen.queryByRole("status")).toBeNull();
});

it("同一文件的新版本从零开始等待提示延迟", () => {
  vi.useFakeTimers();
  const view = render(
    <ReadStatus
      busy
      requestKey="file.txt\0unstaged\0one\00"
      label="正在更新差异…"
    />,
  );
  act(() => vi.advanceTimersByTime(190));
  view.rerender(
    <ReadStatus
      busy
      requestKey="file.txt\0unstaged\0two\00"
      label="正在更新差异…"
    />,
  );
  act(() => vi.advanceTimersByTime(190));
  expect(screen.queryByRole("status")).toBeNull();
  act(() => vi.advanceTimersByTime(10));
  expect(screen.getByRole("status").textContent).toBe("正在更新差异…");
});
