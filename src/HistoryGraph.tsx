import { useMemo, useRef, useState, useEffect, useLayoutEffect } from "react";
import { layoutGraph, visibleEdges, curve, ROW_HEIGHT, COLORS } from "./graph";
import { useGraphMotion } from "./useGraphMotion";
import { CopyButton } from "./CopyButton";
import type { Commit, Snapshot, Reference } from "./types";
export function HistoryGraph({
  commits,
  snapshot,
  selected,
  onSelect,
  locate,
  resetKey,
  active = true,
}: {
  commits: Commit[];
  snapshot: Snapshot;
  selected: string | null;
  onSelect: (hash: string) => void;
  locate: number;
  resetKey: string;
  active?: boolean;
}) {
  const graph = useMemo(
    () => layoutGraph(commits, snapshot.head),
    [commits, snapshot.head],
  );
  const refsByHash = useMemo(() => {
    const groups = new Map<string, Reference[]>();
    for (const ref of snapshot.refs) {
      const group = groups.get(ref.hash);
      if (group) group.push(ref);
      else groups.set(ref.hash, [ref]);
    }
    return groups;
  }, [snapshot.refs]);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef(0);
  const rememberedTop = useRef(0);
  useGraphMotion(canvas, graph, active);
  const [range, setRange] = useState({ top: 0, height: 700 });
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const resize = new ResizeObserver(() => {
      if (el.clientHeight > 0)
        setRange((r) => ({ ...r, height: el.clientHeight }));
    });
    resize.observe(el);
    return () => resize.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  useEffect(() => {
    rememberedTop.current = 0;
    viewport.current?.scrollTo({ top: 0 });
    setRange((r) => ({ ...r, top: 0 }));
    setKeyboardIndex(0);
  }, [resetKey]);
  useLayoutEffect(() => {
    if (active && viewport.current)
      viewport.current.scrollTop = rememberedTop.current;
  }, [active]);
  useEffect(() => {
    if (!locate) return;
    const i = commits.findIndex((c) => c.hash === snapshot.head);
    if (i >= 0) {
      const top = Math.max(0, i * ROW_HEIGHT - 100);
      rememberedTop.current = top;
      viewport.current?.scrollTo({
        top,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
      setKeyboardIndex(i);
      viewport.current?.focus();
    }
    // 定位只由明确的请求触发，分页与自动刷新不能把用户带回顶部。
  }, [locate]);
  const start = Math.max(0, Math.floor(range.top / ROW_HEIGHT) - 5);
  const end = Math.min(
    commits.length,
    Math.ceil((range.top + range.height) / ROW_HEIGHT) + 5,
  );
  return (
    <div
      className="graph-viewport"
      ref={viewport}
      tabIndex={0}
      aria-label="提交历史，使用上下方向键选择，回车查看详情"
      onScroll={(e) => {
        if (!active) return;
        const top = e.currentTarget.scrollTop;
        rememberedTop.current = top;
        cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = requestAnimationFrame(() =>
          setRange((r) =>
            Math.floor(r.top / ROW_HEIGHT) === Math.floor(top / ROW_HEIGHT) &&
            Math.ceil((r.top + r.height) / ROW_HEIGHT) ===
              Math.ceil((top + r.height) / ROW_HEIGHT)
              ? r
              : { ...r, top },
          ),
        );
      }}
      onKeyDown={(e) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const index =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? commits.length - 1
                : Math.min(
                    commits.length - 1,
                    Math.max(
                      0,
                      keyboardIndex + (e.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
          setKeyboardIndex(index);
          const el = viewport.current;
          if (el) {
            if (index * ROW_HEIGHT < el.scrollTop)
              el.scrollTop = index * ROW_HEIGHT;
            else if ((index + 1) * ROW_HEIGHT > el.scrollTop + el.clientHeight)
              el.scrollTop = (index + 1) * ROW_HEIGHT - el.clientHeight;
          }
        }
        if (e.key === "Enter" && commits[keyboardIndex]) {
          e.preventDefault();
          onSelect(commits[keyboardIndex].hash);
        }
      }}
    >
      <div
        className="graph-content"
        ref={canvas}
        style={{
          height: commits.length * ROW_HEIGHT + 24,
          minWidth: graph.width + 220,
        }}
      >
        <svg
          className="graph-lines"
          width={graph.width}
          height={commits.length * ROW_HEIGHT + 24}
          aria-hidden="true"
        >
          {visibleEdges(graph, start, end).map((e) => (
            <path
              key={e.fromHash + "-" + e.toHash}
              data-from={e.fromHash}
              data-to={e.toHash}
              d={curve(e.from, e.to)}
              stroke={e.color}
              strokeWidth={1.6}
              opacity={0.8}
              fill="none"
              strokeDasharray={e.pending ? "4 4" : undefined}
            />
          ))}
          {commits.slice(start, end).map((c) => {
            const p = graph.positions.get(c.hash)!;
            const color = COLORS[p.lane % COLORS.length];
            return (
              <g
                key={c.hash}
                data-node={c.hash}
                transform={"translate(" + p.x + " " + p.y + ")"}
              >
                {c.hash === snapshot.head && (
                  <circle cx={0} cy={0} r={11} fill={color} opacity={0.13} />
                )}
                <circle
                  cx={0}
                  cy={0}
                  r={5}
                  stroke={color}
                  strokeWidth={1.8}
                  fill={selected === c.hash ? color : "var(--bg)"}
                />
              </g>
            );
          })}
        </svg>
        {commits.slice(start, end).map((c, local) => {
          const i = start + local;
          const refs = refsByHash.get(c.hash) ?? [];
          const color =
            COLORS[graph.positions.get(c.hash)!.lane % COLORS.length];
          return (
            <div
              key={c.hash}
              data-row={c.hash}
              className={
                "commit-row " +
                (selected === c.hash ? "selected " : "") +
                (keyboardIndex === i ? "keyboard-row" : "")
              }
              style={{
                top: i * ROW_HEIGHT + 4,
                height: ROW_HEIGHT - 8,
                paddingLeft: graph.width + 8,
              }}
              onClick={() => {
                setKeyboardIndex(i);
                onSelect(c.hash);
              }}
            >
              <div className="commit-title-line">
                <button
                  className="commit-select"
                  tabIndex={-1}
                  aria-pressed={selected === c.hash}
                  title={c.subject}
                >
                  <span className="commit-title">
                    {c.subject || "无提交说明"}
                  </span>
                </button>
                <span
                  className="commit-row-author"
                  title={
                    c.authorEmail ? `${c.author} <${c.authorEmail}>` : c.author
                  }
                >
                  {c.author}
                </span>
                <CopyButton
                  quiet
                  text={`${c.subject}\n${c.hash}`}
                  label="复制提交标题与 ID"
                />
              </div>
              {(refs.length > 0 || c.hash === snapshot.head) && (
                <span className="commit-refs">
                  {refs.map((r) => (
                    <span className="ref-with-copy" key={r.fullName}>
                      <span
                        key={r.fullName}
                        className={"ref " + r.kind}
                        title={r.name}
                        aria-label={r.name}
                        style={
                          r.kind === "branch"
                            ? {
                                color,
                                backgroundColor:
                                  "var(--lane-bg-" +
                                  (graph.positions.get(c.hash)!.lane %
                                    COLORS.length) +
                                  ")",
                              }
                            : undefined
                        }
                      >
                        {r.name.length > 36 ? (
                          <>
                            <span className="ref-prefix">
                              {r.name.slice(0, -12)}
                            </span>
                            <span className="ref-suffix">
                              {r.name.slice(-12)}
                            </span>
                          </>
                        ) : (
                          r.name
                        )}
                      </span>
                      <CopyButton
                        quiet
                        text={r.name}
                        label={`复制${r.kind === "tag" ? "标签" : "分支"}名称：${r.name}`}
                      />
                    </span>
                  ))}
                  {c.hash === snapshot.head && (
                    <span className="head-mark">← HEAD</span>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
