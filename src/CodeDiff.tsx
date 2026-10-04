import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { patchRows } from "./patch";
import { VariableHeightIndex } from "./variableVirtualizer";
import type { ConflictLine } from "./types";
import "./code-diff.css";

type Row = ReturnType<typeof patchRows>[number];
type CodeRow = Row | ConflictLine;
export type SplitRow = { left: Row | null; right: Row | null; meta?: string };
type PatchCodeDiffProps = {
  patch: string;
  layout: "split" | "unified";
  labels?: [string, string];
  includeMetadata?: boolean;
  ariaLabel?: string;
};
type RawCodeDiffProps = { rawLines: ConflictLine[]; ariaLabel: string };

function isPatchRow(row: CodeRow): row is Row {
  return "kind" in row;
}

const BASE_ROW_HEIGHT = 24;
const OVERSCAN = 5;
const SPLIT_RATIO_KEY = "oil-git.diff-split-ratio";
const MIN_SPLIT_RATIO = 0.25;
const MAX_SPLIT_RATIO = 0.75;

function clampSplitRatio(value: number) {
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, value));
}

function readSplitRatio() {
  try {
    const value = Number(localStorage.getItem(SPLIT_RATIO_KEY));
    return Number.isFinite(value) &&
      value >= MIN_SPLIT_RATIO &&
      value <= MAX_SPLIT_RATIO
      ? value
      : 0.5;
  } catch {
    return 0.5;
  }
}

type VirtualizerState<T> = {
  items: T[];
  index: VariableHeightIndex;
  sideHeights: [Float64Array, Float64Array];
  sideGenerations: [Uint32Array, Uint32Array];
  generation: number;
};

function makeVirtualizer<T>(items: T[]): VirtualizerState<T> {
  return {
    items,
    index: new VariableHeightIndex(items.length, BASE_ROW_HEIGHT),
    sideHeights: [
      new Float64Array(items.length),
      new Float64Array(items.length),
    ],
    sideGenerations: [
      new Uint32Array(items.length),
      new Uint32Array(items.length),
    ],
    generation: 1,
  };
}

export function splitRows(rows: Row[]): SplitRow[] {
  const result: SplitRow[] = [],
    removed: Row[] = [],
    added: Row[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      result.push({ left: removed[i] ?? null, right: added[i] ?? null });
    removed.length = 0;
    added.length = 0;
  };
  for (const row of rows) {
    if (row.kind === "remove") {
      removed.push(row);
      continue;
    }
    if (row.kind === "add") {
      added.push(row);
      continue;
    }
    flush();
    if (row.kind === "context") result.push({ left: row, right: row });
    else result.push({ left: null, right: null, meta: row.text });
  }
  flush();
  return result;
}

export function CodeDiff(props: PatchCodeDiffProps | RawCodeDiffProps) {
  const rawLines = "rawLines" in props ? props.rawLines : undefined;
  const patch = "patch" in props ? props.patch : "";
  const layout = "layout" in props ? props.layout : "unified";
  const labels =
    ("labels" in props ? props.labels : undefined) ??
    (["原始内容", "修改后的内容"] as [string, string]);
  const includeMetadata =
    "includeMetadata" in props ? (props.includeMetadata ?? false) : false;
  const ariaLabel = "ariaLabel" in props ? props.ariaLabel : undefined;
  const renderLayout = rawLines ? "unified" : layout;
  const rows = useMemo<CodeRow[]>(
    () => rawLines ?? patchRows(patch),
    [patch, rawLines],
  );
  const hasHunk = rows.some((row) => isPatchRow(row) && row.kind === "hunk");
  const visibleRows = useMemo(
    () =>
      hasHunk && !includeMetadata
        ? rows.filter(
            (row) =>
              !isPatchRow(row) ||
              row.kind !== "meta" ||
              row.text.startsWith("\\"),
          )
        : rows,
    [hasHunk, includeMetadata, rows],
  );
  const split = useMemo(
    () =>
      renderLayout === "split" ? splitRows(visibleRows.filter(isPatchRow)) : [],
    [renderLayout, visibleRows],
  );
  const items: (CodeRow | SplitRow)[] =
    renderLayout === "split" ? split : visibleRows;
  const leftViewport = useRef<HTMLDivElement>(null);
  const rightViewport = useRef<HTMLDivElement>(null);
  const viewports = useMemo(() => [leftViewport, rightViewport] as const, []);
  const splitRoot = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(readSplitRatio);
  const splitRatioRef = useRef(splitRatio);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startRatio: number;
    width: number;
    target: HTMLDivElement;
  } | null>(null);
  const pendingRatio = useRef<number | null>(null);
  const splitFrame = useRef<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastWidths = useRef<[number | null, number | null]>([null, null]);
  const rowNodes = useRef(new Map<string, HTMLDivElement>());
  const rowCallbacks = useRef(
    new Map<string, (node: HTMLDivElement | null) => void>(),
  );
  const raf = useRef<number | null>(null);
  const pendingTop = useRef(0);
  const virtualizerRef = useRef<VirtualizerState<CodeRow | SplitRow> | null>(
    null,
  );
  if (!virtualizerRef.current || virtualizerRef.current.items !== items)
    virtualizerRef.current = makeVirtualizer<CodeRow | SplitRow>(items);

  const initialMetrics = { top: 0, height: 600, revision: 0 };
  const [metrics, setMetrics] = useState(initialMetrics);
  const metricsRef = useRef(metrics);

  const publishMetrics = useCallback(
    (top: number, height: number, force = false) => {
      const current = metricsRef.current;
      const next = {
        top: Math.max(0, top),
        height: height > 0 ? height : current.height,
        revision: current.revision + 1,
      };
      if (!force && next.top === current.top && next.height === current.height)
        return;
      metricsRef.current = next;
      setMetrics(next);
    },
    [],
  );

  const applySplitRatio = useCallback((ratio: number) => {
    const next = clampSplitRatio(ratio);
    splitRatioRef.current = next;
    splitRoot.current?.style.setProperty("--diff-left-track", `${next}fr`);
    splitRoot.current?.style.setProperty("--diff-right-track", `${1 - next}fr`);
    divider.current?.setAttribute(
      "aria-valuenow",
      String(Math.round(next * 100)),
    );
  }, []);

  const commitSplitRatio = useCallback(
    (ratio: number) => {
      const next = Number(clampSplitRatio(ratio).toFixed(4));
      applySplitRatio(next);
      setSplitRatio(next);
      try {
        localStorage.setItem(SPLIT_RATIO_KEY, String(next));
      } catch {
        /* 当前窗口仍可调整。 */
      }
    },
    [applySplitRatio],
  );

  const finishSplitDrag = useCallback(
    (accept: boolean) => {
      const current = drag.current;
      if (!current) return;
      if (splitFrame.current !== null) cancelAnimationFrame(splitFrame.current);
      splitFrame.current = null;
      const desired = pendingRatio.current;
      pendingRatio.current = null;
      drag.current = null;
      splitRoot.current?.removeAttribute("data-resizing");
      if (accept) commitSplitRatio(desired ?? current.startRatio);
      else applySplitRatio(current.startRatio);
      if (current.target.hasPointerCapture?.(current.pointerId))
        current.target.releasePointerCapture(current.pointerId);
    },
    [applySplitRatio, commitSplitRatio],
  );

  useLayoutEffect(() => {
    if (renderLayout === "split") applySplitRatio(splitRatio);
    else finishSplitDrag(false);
  }, [applySplitRatio, finishSplitDrag, renderLayout, splitRatio]);

  useEffect(() => {
    const cancel = () => finishSplitDrag(false);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      if (splitFrame.current !== null) cancelAnimationFrame(splitFrame.current);
      splitFrame.current = null;
      const current = drag.current;
      drag.current = null;
      pendingRatio.current = null;
      if (current?.target.hasPointerCapture?.(current.pointerId))
        current.target.releasePointerCapture(current.pointerId);
    };
  }, [finishSplitDrag]);

  const onDividerPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !splitRoot.current) return;
      event.preventDefault();
      finishSplitDrag(false);
      const width = splitRoot.current.clientWidth - 6;
      if (width <= 0) return;
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startRatio: splitRatioRef.current,
        width,
        target: event.currentTarget,
      };
      splitRoot.current.setAttribute("data-resizing", "true");
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [finishSplitDrag],
  );

  const onDividerPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      event.preventDefault();
      pendingRatio.current = clampSplitRatio(
        current.startRatio + (event.clientX - current.startX) / current.width,
      );
      if (splitFrame.current !== null) return;
      splitFrame.current = requestAnimationFrame(() => {
        splitFrame.current = null;
        if (pendingRatio.current !== null)
          applySplitRatio(pendingRatio.current);
      });
    },
    [applySplitRatio],
  );

  const onDividerPointerEnd = useCallback(
    (event: PointerEvent<HTMLDivElement>, accept: boolean) => {
      if (drag.current?.pointerId === event.pointerId) finishSplitDrag(accept);
    },
    [finishSplitDrag],
  );

  const onDividerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        if (drag.current) {
          event.preventDefault();
          finishSplitDrag(false);
        }
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const ratio =
        event.key === "Home"
          ? MIN_SPLIT_RATIO
          : event.key === "End"
            ? MAX_SPLIT_RATIO
            : splitRatioRef.current +
              (event.key === "ArrowRight" ? 0.02 : -0.02);
      commitSplitRatio(ratio);
    },
    [commitSplitRatio, finishSplitDrag],
  );

  const getRowRef = useCallback((index: number, side: number) => {
    const key = `${index}:${side}`;
    let callback = rowCallbacks.current.get(key);
    if (!callback) {
      callback = (node) => {
        const previous = rowNodes.current.get(key);
        if (previous === node) return;
        if (previous) {
          observerRef.current?.unobserve(previous);
          rowNodes.current.delete(key);
        }
        if (node) {
          rowNodes.current.set(key, node);
          observerRef.current?.observe(node);
        } else {
          rowCallbacks.current.delete(key);
        }
      };
      rowCallbacks.current.set(key, callback);
    }
    return callback;
  }, []);

  const syncScrollTop = useCallback(
    (top: number) => {
      for (const ref of viewports) {
        const viewport = ref.current;
        if (viewport && Math.abs(viewport.scrollTop - top) > 0.5)
          viewport.scrollTop = top;
      }
    },
    [viewports],
  );

  const onScroll = useCallback(
    (top: number, side: number) => {
      const other = viewports[1 - side]?.current;
      if (other && Math.abs(other.scrollTop - top) > 0.5) other.scrollTop = top;
      pendingTop.current = top;
      if (raf.current !== null) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = null;
        publishMetrics(pendingTop.current, metricsRef.current.height);
      });
    },
    [publishMetrics, viewports],
  );

  useLayoutEffect(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    pendingTop.current = 0;
    syncScrollTop(0);
    const viewportHeight = viewports[0].current?.clientHeight ?? 0;
    publishMetrics(0, viewportHeight || 600, true);
    const observer = observerRef.current;
    if (observer) {
      // The index was reset for these items. Re-observe mounted rows so
      // unchanged natural heights are reported into the new index as well.
      for (const row of rowNodes.current.values()) {
        observer.unobserve?.(row);
        observer.observe(row);
      }
    }
  }, [items, renderLayout, publishMetrics, syncScrollTop, viewports]);

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const viewEntries = entries.filter((entry) =>
        viewports.some((ref) => ref.current === entry.target),
      );
      let widthChanged = false;
      let viewportHeight = metricsRef.current.height;
      for (const entry of viewEntries) {
        const side = viewports.findIndex((ref) => ref.current === entry.target);
        const width = entry.contentRect.width;
        if (width > 0) {
          const previous = lastWidths.current[side];
          if (previous !== null && Math.abs(previous - width) > 0.5)
            widthChanged = true;
          lastWidths.current[side] = width;
        }
        if (side === 0 && entry.contentRect.height > 0)
          viewportHeight = entry.contentRect.height;
      }

      const state = virtualizerRef.current;
      if (!state) return;
      const viewport = viewports[0].current;
      const scrollTop = viewport?.scrollTop ?? metricsRef.current.top;
      const anchor = state.index.anchorAt(scrollTop);
      if (widthChanged) {
        state.index.reset();
        if (state.generation === 0xffff_ffff) {
          state.sideGenerations[0].fill(0);
          state.sideGenerations[1].fill(0);
          state.generation = 1;
        } else {
          state.generation++;
        }
        if (raf.current !== null) cancelAnimationFrame(raf.current);
        raf.current = null;
      }

      const rowEntries = entries.filter((entry) =>
        entry.target.hasAttribute("data-virtual-index"),
      );
      let changed = widthChanged;
      const updates = new Map<number, [number | null, number | null]>();
      for (const entry of rowEntries) {
        const target = entry.target as HTMLElement;
        const index = Number(target.dataset.virtualIndex);
        const side = Number(target.dataset.virtualSide);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= state.items.length ||
          (side !== 0 && side !== 1) ||
          entry.contentRect.height <= 0
        )
          continue;
        const pair = updates.get(index) ?? [null, null];
        pair[side] = Math.max(
          BASE_ROW_HEIGHT,
          Math.ceil(entry.contentRect.height),
        );
        updates.set(index, pair);
      }

      for (const [index, sides] of updates) {
        for (const side of [0, 1] as const) {
          if (sides[side] !== null) {
            state.sideHeights[side][index] = sides[side]!;
            state.sideGenerations[side][index] = state.generation;
          }
        }
        const leftHeight =
          state.sideGenerations[0][index] === state.generation
            ? state.sideHeights[0][index]
            : BASE_ROW_HEIGHT;
        const rightHeight =
          state.sideGenerations[1][index] === state.generation
            ? state.sideHeights[1][index]
            : BASE_ROW_HEIGHT;
        const pairHeight = Math.max(leftHeight, rightHeight);
        changed = state.index.setHeight(index, pairHeight) || changed;
      }
      if (changed) {
        const nextTop = state.index.offsetForAnchor(anchor);
        pendingTop.current = nextTop;
        if (Math.abs(nextTop - scrollTop) > 0.5) syncScrollTop(nextTop);
        publishMetrics(nextTop, viewportHeight, true);
      } else if (viewportHeight !== metricsRef.current.height) {
        publishMetrics(scrollTop, viewportHeight, true);
      }
    });

    observerRef.current = observer;
    viewports.forEach((ref) => {
      const viewport = ref.current;
      if (!viewport) return;
      observer.observe(viewport);
      viewport
        .querySelectorAll<HTMLElement>("[data-virtual-index]")
        .forEach((row) => observer.observe(row));
    });
    return () => {
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
      lastWidths.current = [null, null];
    };
  }, [renderLayout, publishMetrics, syncScrollTop, viewports]);

  useLayoutEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      observerRef.current?.disconnect();
      rowNodes.current.clear();
      rowCallbacks.current.clear();
    },
    [],
  );

  const state = virtualizerRef.current;
  const visible = state.index.range(metrics.top, metrics.height, OVERSCAN);
  const rowStyle = (index: number) => ({
    top: state.index.prefix(index),
    minHeight: state.index.heightAt(index),
  });

  if (renderLayout === "unified")
    return (
      <div
        className={
          "code-viewport code-diff-viewport unified-code" +
          (includeMetadata ? " raw-patch-viewport" : "") +
          (rawLines ? " raw-code-viewport" : "")
        }
        ref={leftViewport}
        tabIndex={0}
        aria-label={ariaLabel ?? "统一代码差异"}
        onScroll={(e) => onScroll(e.currentTarget.scrollTop, 0)}
      >
        <div className="code-spacer" style={{ height: visible.totalHeight }}>
          {visibleRows.slice(visible.start, visible.end).map((row, offset) => {
            const index = visible.start + offset;
            const isPatch = isPatchRow(row);
            const kind = isPatch ? row.kind : "source";
            return (
              <div
                key={index}
                className={`virtual-code-row code-line-slot ${kind}`}
                style={rowStyle(index)}
              >
                <div
                  ref={getRowRef(index, 0)}
                  data-virtual-index={index}
                  data-virtual-side={0}
                  className={`code-row code-line-measure ${kind}`}
                >
                  <span className="line-number">
                    {isPatch ? row.a : row.line}
                  </span>
                  {isPatch && <span className="line-number">{row.b}</span>}
                  <span className="code-text">{row.text}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );

  return (
    <div className="split-editor code-diff-split" ref={splitRoot}>
      {[0, 1].map((side) => (
        <section className="split-side" key={side}>
          <div className="split-label">{labels[side]}</div>
          <div
            className="code-viewport code-diff-viewport"
            ref={viewports[side]}
            tabIndex={0}
            aria-label={labels[side]}
            onScroll={(e) => onScroll(e.currentTarget.scrollTop, side)}
          >
            <div
              className="code-spacer"
              style={{ height: visible.totalHeight }}
            >
              {split.slice(visible.start, visible.end).map((pair, offset) => {
                const index = visible.start + offset;
                const row = side === 0 ? pair.left : pair.right;
                return (
                  <div
                    className={
                      "virtual-code-row code-line-slot " +
                      (row?.kind ?? (pair.meta ? "meta" : "spacer"))
                    }
                    key={index}
                    style={rowStyle(index)}
                  >
                    <div
                      ref={getRowRef(index, side)}
                      data-virtual-index={index}
                      data-virtual-side={side}
                      className={
                        "code-row code-line-measure " +
                        (row?.kind ?? (pair.meta ? "meta" : "spacer"))
                      }
                    >
                      <span className="line-number">
                        {row ? (side === 0 ? row.a : row.b) : ""}
                      </span>
                      <span className="code-text">
                        {pair.meta ?? (row ? row.text.slice(1) : "")}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      ))}
      <div
        ref={divider}
        className="code-diff-divider"
        role="separator"
        aria-label="调整左右差异宽度"
        aria-orientation="vertical"
        aria-valuemin={25}
        aria-valuemax={75}
        aria-valuenow={Math.round(splitRatio * 100)}
        tabIndex={0}
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={(event) => onDividerPointerEnd(event, true)}
        onPointerCancel={(event) => onDividerPointerEnd(event, false)}
        onLostPointerCapture={(event) => onDividerPointerEnd(event, false)}
        onKeyDown={onDividerKeyDown}
      />
    </div>
  );
}

export function CodeLines({
  lines,
  label,
}: {
  lines: ConflictLine[];
  label: string;
}) {
  return <CodeDiff rawLines={lines} ariaLabel={label} />;
}
