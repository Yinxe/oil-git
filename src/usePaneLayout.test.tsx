// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
} from "@testing-library/react";
import { useRef } from "react";
import { usePaneLayout } from "./usePaneLayout";
let resize: () => void,
  width = 1280;
beforeEach(() => {
  localStorage.clear();
  width = 1280;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fn: () => void) {
        resize = fn;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId = 1;
    },
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Harness() {
  const shell = useRef<HTMLDivElement>(null);
  const layout = usePaneLayout(shell);
  return (
    <div ref={shell} data-testid="shell" data-dragging={layout.dragging}>
      <div role="separator" aria-label="侧栏" {...layout.handle("sidebar")} />
      <div role="separator" aria-label="详情" {...layout.handle("detail")} />
    </div>
  );
}
it("键盘调整两处分界，窗口缩窄再放大恢复原偏好", () => {
  render(<Harness />);
  const sidebar = screen.getByLabelText("侧栏"),
    detail = screen.getByLabelText("详情"),
    shell = screen.getByTestId("shell");
  fireEvent.keyDown(sidebar, { key: "End" });
  fireEvent.keyDown(detail, { key: "ArrowLeft" });
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("460px");
  expect(shell.style.getPropertyValue("--detail-width")).toBe("440px");
  width = 720;
  act(() => resize());
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("320px");
  expect(shell.dataset.compactDetails).toBe("true");
  width = 1280;
  act(() => resize());
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("460px");
  expect(shell.style.getPropertyValue("--detail-width")).toBe("440px");
  expect(localStorage.getItem("oil-git.sidebar-width")).toBe("460");
});
it("连续拖拽可结束，取消与失焦不保存临时宽度", () => {
  render(<Harness />);
  const handle = screen.getByLabelText("侧栏"),
    shell = screen.getByTestId("shell");
  fireEvent.pointerDown(handle, { button: 0, clientX: 250 });
  fireEvent.pointerMove(handle, { clientX: 350 });
  fireEvent.pointerUp(handle);
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("350px");
  expect(localStorage.getItem("oil-git.sidebar-width")).toBe("350");
  fireEvent.pointerDown(handle, { button: 0, clientX: 350 });
  fireEvent.pointerMove(handle, { clientX: 430 });
  fireEvent.pointerCancel(handle);
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("350px");
  expect(localStorage.getItem("oil-git.sidebar-width")).toBe("350");
  fireEvent.pointerDown(handle, { button: 0, clientX: 350 });
  fireEvent.pointerMove(handle, { clientX: 280 });
  fireEvent.blur(window);
  expect(shell.dataset.dragging).toBe("false");
  expect(shell.style.getPropertyValue("--sidebar-width")).toBe("350px");
});
