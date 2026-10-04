import { describe, it, expect } from "vitest";
import { layoutGraph, visibleEdges, ROW_HEIGHT } from "./graph";
import { RequestGate } from "./api";
import { patchRows } from "./DiffView";
import { fileModes } from "./useWorkingCopy";
import { splitRows } from "./CodeDiff";
import type { Commit, FileState } from "./types";
const commit = (hash: string, parents: string[]): Commit => ({
  hash,
  parents,
  subject: hash,
  date: "2026-01-01",
  author: "测试",
});
describe("真实提交关系与异步归属", () => {
  it("可见边查询保留跨视口合并连线与未加载父节点", () => {
    const commits = [
      commit("merge", ["a", "far"]),
      commit("a", ["b"]),
      commit("b", ["far"]),
      commit("far", ["unloaded"]),
    ];
    const graph = layoutGraph(commits, "merge");
    for (let start = 0; start < 5; start++)
      for (let end = start + 1; end <= 5; end++) {
        expect(visibleEdges(graph, start, end)).toEqual(
          graph.edges.filter((e) => e.from.index < end && e.to.index >= start),
        );
      }
  });
  it("分页边界保留父提交，加载后延续原轨道", () => {
    const first = [
      commit("merge", ["a", "b"]),
      commit("a", ["root"]),
      commit("b", ["root"]),
    ];
    const before = layoutGraph(first, "merge"),
      after = layoutGraph([...first, commit("root", [])], "merge");
    expect(before.edges.filter((e) => e.pending)).toHaveLength(2);
    expect(before.edges.find((e) => e.pending)?.to.y).toBeGreaterThan(
      3 * ROW_HEIGHT,
    );
    for (const c of first)
      expect(before.positions.get(c.hash)).toEqual(after.positions.get(c.hash));
    expect(after.edges.some((e) => e.pending)).toBe(false);
    expect(after.positions.get("a")?.lane).not.toBe(
      after.positions.get("b")?.lane,
    );
  });
  it("关闭、换仓库或快速重选后丢弃旧响应", () => {
    const gate = new RequestGate();
    const a = gate.next();
    const b = gate.next();
    expect(gate.accepts(a)).toBe(false);
    expect(gate.accepts(b)).toBe(true);
    gate.invalidate();
    expect(gate.accepts(b)).toBe(false);
  });
  it("同时暂存与未暂存修改有两个比较范围", () => {
    const file = {
      path: "file",
      staged: true,
      unstaged: true,
      conflict: false,
      untracked: false,
    } as FileState;
    expect(fileModes(file)).toEqual(["unstaged", "staged"]);
    expect(fileModes({ ...file, conflict: true })).toEqual(["conflict"]);
  });
  it("行号来自真实 hunk，无末尾换行提示不计行数", () => {
    const rows = patchRows(
      "@@ -2,1 +2,2 @@\n-old\n+new\n\\ No newline at end of file\n+second",
    );
    expect(rows[1].a).toBe(2);
    expect(rows[2].b).toBe(2);
    expect(rows[3].b).toBe("");
    expect(rows[4].b).toBe(3);
  });
  it("左右对照按变更段配对删除与新增行", () => {
    const rows = splitRows(
      patchRows("@@ -1,2 +1,3 @@\n-old1\n-old2\n+new1\n+new2\n+new3"),
    );
    expect(rows[1].left?.a).toBe(1);
    expect(rows[1].right?.b).toBe(1);
    expect(rows[3].left).toBeNull();
    expect(rows[3].right?.b).toBe(3);
  });
});
