import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

// 测量内容一次，CSS 从当前高度向新高度过渡，快速反向操作不会重播起点。
export function Collapse({
  expanded,
  children,
  className = "",
}: {
  expanded: boolean;
  children: ReactNode;
  className?: string;
}) {
  const outer = useRef<HTMLDivElement>(null),
    inner = useRef<HTMLDivElement>(null);
  const open = useRef(expanded);
  const previous = useRef(expanded);
  const animating = useRef(false);
  open.current = expanded;
  useLayoutEffect(() => {
    const container = outer.current!,
      content = inner.current!;
    const measure = () => {
      // 展开结束后跟随自然高度；嵌套目录的动画不应再触发父层的高度动画。
      if (open.current && !animating.current) {
        container.style.height = "auto";
        return;
      }
      const next = open.current ? content.getBoundingClientRect().height : 0;
      const height = next + "px";
      if (container.style.height !== height) container.style.height = height;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    let live = true;
    queueMicrotask(() => {
      if (live) container.setAttribute("data-animated", "true");
    });
    return () => {
      observer.disconnect();
      live = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (previous.current === expanded || !outer.current || !inner.current)
      return;
    previous.current = expanded;
    const container = outer.current;
    const target = expanded ? inner.current.getBoundingClientRect().height : 0;
    if (container.style.height === "auto") {
      container.style.height = container.getBoundingClientRect().height + "px";
      // 仅切换瞬间确定起点，连续帧不读取布局。
      void container.offsetHeight;
    }
    animating.current = true;
    container.style.height = target + "px";
  }, [expanded]);
  return (
    <div
      className={"change-group-fold " + className}
      ref={outer}
      data-expanded={expanded}
      aria-hidden={!expanded}
      inert={!expanded}
      onTransitionEnd={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.propertyName !== "height"
        )
          return;
        animating.current = false;
        if (open.current) event.currentTarget.style.height = "auto";
      }}
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}
