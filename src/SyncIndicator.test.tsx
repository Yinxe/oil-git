// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SyncIndicator } from "./SyncIndicator";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("同步快速完成不闪现，慢同步显示细线，换仓库、隐藏及完成时立即清除", () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("visible");
  const view = render(<SyncIndicator busy requestKey="first" />);
  act(() => vi.advanceTimersByTime(100));
  view.rerender(<SyncIndicator busy={false} requestKey="first" />);
  act(() => vi.advanceTimersByTime(300));
  expect(screen.queryByRole("progressbar")).toBeNull();
  view.rerender(<SyncIndicator busy requestKey="second" />);
  act(() => vi.advanceTimersByTime(200));
  expect(
    screen.getByRole("progressbar", { name: "正在同步仓库" }),
  ).toBeTruthy();
  view.rerender(<SyncIndicator busy requestKey="third" />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  act(() => vi.advanceTimersByTime(200));
  visibility.mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(screen.queryByRole("progressbar")).toBeNull();
  visibility.mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole("progressbar")).toBeTruthy();
  view.rerender(<SyncIndicator busy={false} requestKey="third" />);
  expect(screen.queryByRole("progressbar")).toBeNull();
});
