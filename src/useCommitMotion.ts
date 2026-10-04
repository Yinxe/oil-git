import { useCallback, useLayoutEffect, useRef } from "react";

// 方向由已经显示的提交决定；请求期间保留旧内容，不为尚未到达的节点播放动画。
export function useCommitMotion(
  hash: string | null,
  commits: readonly { hash: string }[],
  active: boolean,
) {
  const content = useRef<HTMLDivElement>(null);
  const previous = useRef<string | null>(null);
  const animation = useRef<Animation | null>(null);
  const stop = useCallback(() => {
    animation.current?.cancel();
    animation.current = null;
  }, []);
  useLayoutEffect(() => {
    if (!active || !hash) {
      previous.current = null;
      stop();
      return;
    }
    const from = previous.current;
    previous.current = hash;
    if (from === hash) return;
    stop();
    if (
      !from ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const oldIndex = commits.findIndex((commit) => commit.hash === from);
    const newIndex = commits.findIndex((commit) => commit.hash === hash);
    const element = content.current;
    if (!element || oldIndex < 0 || newIndex < 0) return;
    const offset = newIndex < oldIndex ? 12 : -12;
    animation.current = element.animate(
      [
        { transform: `translateY(${offset}px)`, opacity: 0.94 },
        { transform: "translateY(0)", opacity: 1 },
      ],
      {
        duration: 200,
        easing:
          getComputedStyle(element).getPropertyValue("--ease").trim() ||
          "cubic-bezier(0.2, 0.75, 0.25, 1)",
      },
    );
  }, [hash, commits, active, stop]);
  useLayoutEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const reduce = () => {
      if (preference?.matches) stop();
    };
    preference?.addEventListener("change", reduce);
    return () => {
      preference?.removeEventListener("change", reduce);
      stop();
    };
  }, [stop]);
  return content;
}
