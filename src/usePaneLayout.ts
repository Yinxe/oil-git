import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";

type Pane = "sidebar" | "detail";
const defaults = { sidebar: 250, detail: 420 };
function saved(pane: Pane) {
  try {
    const value = Number(localStorage.getItem("oil-git." + pane + "-width"));
    return Number.isFinite(value) && value >= 180 && value <= 4096
      ? value
      : defaults[pane];
  } catch {
    return defaults[pane];
  }
}
export function usePaneLayout(shell: RefObject<HTMLDivElement | null>) {
  const preferred = useRef({
    sidebar: saved("sidebar"),
    detail: saved("detail"),
  });
  const effective = useRef({ ...preferred.current });
  const [dragging, setDragging] = useState(false);
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(false);
  const viewportWidth = useRef(1280);
  const [, commitSize] = useState(0);
  const gesture = useRef<{
    pane: Pane;
    pointerId: number;
    origin: number;
    size: number;
    target: HTMLElement;
  } | null>(null);
  const frame = useRef(0),
    desired = useRef<number | null>(null);
  const bounds = (pane: Pane) => {
    const width = viewportWidth.current;
    return pane === "sidebar"
      ? [180, Math.min(460, Math.max(180, width - 400))]
      : [260, Math.max(260, width - effective.current.sidebar - 286)];
  };
  const apply = (pane: Pane, value: number) => {
    const [min, max] = bounds(pane);
    effective.current[pane] = Math.round(Math.max(min, Math.min(max, value)));
    shell.current?.style.setProperty(
      "--" + pane + "-width",
      effective.current[pane] + "px",
    );
    const nextCompact = viewportWidth.current - effective.current.sidebar < 720;
    shell.current?.setAttribute("data-compact-details", String(nextCompact));
    if (nextCompact !== compactRef.current) {
      compactRef.current = nextCompact;
      setCompact(nextCompact);
    }
    shell.current
      ?.querySelectorAll<HTMLElement>("[data-pane]")
      .forEach((element) => {
        const kind = element.dataset.pane as Pane;
        const [min, max] = bounds(kind);
        element.setAttribute("aria-valuemin", String(min));
        element.setAttribute("aria-valuemax", String(max));
        element.setAttribute("aria-valuenow", String(effective.current[kind]));
      });
  };
  const fit = () => {
    apply("sidebar", preferred.current.sidebar);
    apply("detail", preferred.current.detail);
  };
  const persist = (pane: Pane) => {
    try {
      localStorage.setItem(
        "oil-git." + pane + "-width",
        String(preferred.current[pane]),
      );
    } catch {
      /* 临时窗口仍可调整。 */
    }
    commitSize((value) => value + 1);
  };
  const finish = (accept: boolean) => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const current = gesture.current;
    if (!current) return;
    if (accept && desired.current !== null)
      apply(current.pane, desired.current);
    if (accept && current.pane === "sidebar")
      apply("detail", preferred.current.detail);
    if (
      accept &&
      Math.abs(effective.current[current.pane] - current.size) >= 1
    ) {
      preferred.current[current.pane] = effective.current[current.pane];
      persist(current.pane);
    } else {
      fit();
      commitSize((value) => value + 1);
    }
    gesture.current = null;
    desired.current = null;
    if (current.target.hasPointerCapture?.(current.pointerId))
      current.target.releasePointerCapture(current.pointerId);
    setDragging(false);
  };
  useLayoutEffect(() => {
    const element = shell.current;
    if (!element) return;
    viewportWidth.current = element.clientWidth || 1280;
    fit();
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth;
      if (width) {
        viewportWidth.current = width;
        fit();
      }
    });
    observer.observe(element);
    const cancel = () => finish(false);
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      observer.disconnect();
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
      cancelAnimationFrame(frame.current);
      gesture.current = null;
    };
  }, []);
  const handle = (pane: Pane) => ({
    "data-pane": pane,
    "aria-valuemin": bounds(pane)[0],
    "aria-valuemax": bounds(pane)[1],
    "aria-valuenow": effective.current[pane],
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      finish(false);
      gesture.current = {
        pane,
        pointerId: event.pointerId,
        origin: event.clientX,
        size: effective.current[pane],
        target: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const current = gesture.current;
      if (
        !current ||
        current.pane !== pane ||
        current.pointerId !== event.pointerId
      )
        return;
      desired.current =
        current.size +
        (event.clientX - current.origin) * (pane === "sidebar" ? 1 : -1);
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (desired.current !== null) {
          apply(pane, desired.current);
          if (pane === "sidebar") apply("detail", preferred.current.detail);
        }
      });
    },
    onPointerUp: () => finish(true),
    onPointerCancel: () => finish(false),
    onLostPointerCapture: () => finish(false),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const [min, max] = bounds(pane);
      apply(
        pane,
        event.key === "Home"
          ? min
          : event.key === "End"
            ? max
            : effective.current[pane] +
              (event.key === "ArrowRight" ? 20 : -20) *
                (pane === "sidebar" ? 1 : -1),
      );
      preferred.current[pane] = effective.current[pane];
      if (pane === "sidebar") apply("detail", preferred.current.detail);
      persist(pane);
    },
  });
  return { dragging, compact, handle };
}
