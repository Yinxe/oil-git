import { useLayoutEffect, useRef, type RefObject } from "react";
import { curve, ROW_HEIGHT, layoutGraph } from "./graph";
type Point = { x: number; y: number };
type Graph = ReturnType<typeof layoutGraph>;
// 只对当前可见元素写入，坐标直接由提交图计算；不逐帧测量布局或更新 React 状态。
export function useGraphMotion(
  container: RefObject<HTMLDivElement | null>,
  graph: Graph,
  active = true,
) {
  const displayed = useRef<Map<string, Point> | null>(null);
  const previousWidth = useRef(graph.width);
  useLayoutEffect(() => {
    const target = new Map<string, Point>(graph.positions);
    graph.edges.forEach((e) => {
      if (!target.has(e.toHash)) target.set(e.toHash, e.to);
    });
    const before = displayed.current;
    const element = container.current;
    const oldWidth = previousWidth.current;
    previousWidth.current = graph.width;
    if (
      !active ||
      !before ||
      !element ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      displayed.current = target;
      return;
    }
    const changed = [...target].some(([hash, p]) => {
      const old = before.get(hash);
      return old && (old.x !== p.x || old.y !== p.y);
    });
    if (!changed) {
      displayed.current = target;
      return;
    }
    const nodes = [...element.querySelectorAll<SVGGElement>("[data-node]")];
    const rows = [...element.querySelectorAll<HTMLElement>("[data-row]")];
    const paths = [...element.querySelectorAll<SVGPathElement>("[data-from]")];
    const moving = new Map(target);
    let frame = 0;
    const start = performance.now();
    const draw = (now: number) => {
      const progress = Math.min(1, (now - start) / 240),
        t = 1 - Math.pow(1 - progress, 3);
      const current = new Map<string, Point>();
      const point = (hash: string) => {
        const known = current.get(hash);
        if (known) return known;
        const p = target.get(hash);
        if (!p) return;
        const old = before.get(hash) ?? p;
        const next = {
          x: old.x + (p.x - old.x) * t,
          y: old.y + (p.y - old.y) * t,
        };
        current.set(hash, next);
        moving.set(hash, next);
        return next;
      };
      displayed.current = moving;
      nodes.forEach((node) => {
        const p = point(node.dataset.node!);
        if (p)
          node.setAttribute("transform", "translate(" + p.x + " " + p.y + ")");
      });
      rows.forEach((row) => {
        const hash = row.dataset.row!,
          p = point(hash),
          end = target.get(hash);
        if (p && end)
          row.style.transform =
            "translate(" +
            (oldWidth - graph.width) * (1 - t) +
            "px," +
            (p.y - end.y) +
            "px)";
      });
      paths.forEach((path) => {
        const p = point(path.dataset.from!),
          q = point(path.dataset.to!);
        if (p && q) path.setAttribute("d", curve(p, q));
      });
      if (progress < 1) frame = requestAnimationFrame(draw);
      else {
        rows.forEach((row) => (row.style.transform = ""));
        displayed.current = target;
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      rows.forEach((row) => (row.style.transform = ""));
    };
  }, [graph, container, active]);
}
