// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { DiffView } from "./DiffView";
import { LanguageProvider } from "./i18n";
import type { Diff } from "./types";

afterEach(cleanup);
const base: Diff = {
  patch: "",
  truncated: false,
  binary: false,
  note: null,
  conflict: null,
};
const first = { oid: "a".repeat(64), size: 1234 };
const second = { oid: "b".repeat(64), size: 5678 };
it("LFS 分别显示前后真实对象，不把指针当作文件正文", () => {
  render(
    <DiffView
      data={{
        ...base,
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        lfs: { before: first, after: second },
      }}
      labels={["HEAD", "暂存区"]}
    />,
  );
  const region = screen.getByRole("region", { name: "Git LFS 对象变化" });
  expect(
    within(region).getByRole("region", { name: "HEAD" }).textContent,
  ).toContain(first.oid);
  expect(
    within(region).getByRole("region", { name: "暂存区" }).textContent,
  ).toContain("5,678 字节");
  expect(region.textContent).toContain("不下载文件内容");
  const details = screen.getByText("原始指针差异").closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("原始指针差异"));
  expect(details.open).toBe(true);
});
it("LFS 新增与删除明确表示不存在的比较侧", () => {
  const view = render(
    <DiffView data={{ ...base, lfs: { before: null, after: first } }} />,
  );
  expect(screen.getByRole("region", { name: "变更前" }).textContent).toContain(
    "无 LFS 对象",
  );
  view.rerender(
    <DiffView data={{ ...base, lfs: { before: first, after: null } }} />,
  );
  expect(screen.getByRole("region", { name: "变更后" }).textContent).toContain(
    "无 LFS 对象",
  );
});
it("普通文件仍显示自身空结果或二进制提示", () => {
  const view = render(
    <DiffView data={{ ...base, note: "当前比较范围没有差异。" }} />,
  );
  expect(screen.queryByRole("region", { name: "Git LFS 对象变化" })).toBeNull();
  expect(screen.getByText("当前比较范围没有差异。")).toBeTruthy();
  view.rerender(<DiffView data={{ ...base, binary: true }} />);
  expect(
    screen.getByText("二进制文件发生变化，无法显示文本差异。"),
  ).toBeTruthy();
});
it("普通内容转换与文件删除不会混淆", () => {
  render(
    <DiffView
      data={{
        ...base,
        lfs: {
          before: null,
          after: null,
          beforeState: "regular",
          afterState: "missing",
        },
      }}
    />,
  );
  expect(screen.getByRole("region", { name: "变更前" }).textContent).toContain(
    "此侧是普通文件内容",
  );
  expect(screen.getByRole("region", { name: "变更后" }).textContent).toContain(
    "文件不存在",
  );
});
it("有原始差异时也呈现读取范围的限制说明", () => {
  const note =
    "当前 Git 无法读取历史属性，以下是 Git 原始差异，未确认 LFS 状态。";
  render(
    <DiffView
      data={{
        ...base,
        patch: "@@ -0,0 +1 @@\n+version https://git-lfs.github.com/spec/v1\n",
        note,
      }}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(note);
  expect(screen.getByText("Git 原始差异").closest("details")!.open).toBe(false);
});
it("二进制历史差异仍显示未确认 LFS 警告和原始诊断", () => {
  localStorage.setItem("oil-git.language", "en");
  const note =
    "当前 Git 无法读取历史属性，以下是 Git 原始差异，未确认 LFS 状态。";
  render(
    <LanguageProvider>
      <DiffView
        data={{
          ...base,
          binary: true,
          patch: "Binary files a/data.bin and b/data.bin differ",
          note,
          noteKey: "lfsAttributeSourceUnsupported",
        }}
      />
    </LanguageProvider>,
  );
  expect(
    screen.getByText("A binary file changed; text diff is unavailable."),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Git could not read historical LFS attributes. The raw diff is still available.",
    ),
  ).toBeTruthy();
  const diagnostic = screen.getByText("View original diagnostic");
  const details = diagnostic.closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(diagnostic);
  expect(details.open).toBe(true);
  expect(details.textContent).toContain(note);
  expect(screen.getByText("Raw Git diff")).toBeTruthy();
  expect(
    screen.getByText("Binary files a/data.bin and b/data.bin differ"),
  ).toBeTruthy();
});
it("LFS 冲突展示真实双方对象，原始指针冲突按需查看", () => {
  render(
    <DiffView
      data={{
        ...base,
        patch: "@@ -1 +1 @@\n-old\n+new\n",
        conflict: {
          kind: "双方修改",
          note: null,
          blocks: [
            {
              startLine: 1,
              endLine: 4,
              ours: [{ line: 2, text: "oid sha256:raw" }],
              base: [],
              theirs: [],
              incoming: "",
            },
          ],
        },
        lfs: { before: first, after: second, conflict: true },
      }}
    />,
  );
  expect(screen.getByText("未解决冲突")).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "当前分支" }).textContent,
  ).toContain(first.oid);
  expect(
    screen.getByRole("region", { name: "合入分支" }).textContent,
  ).toContain(second.oid);
  expect(screen.queryByText("当前分支的内容")).toBeNull();
  expect(screen.getByText("原始指针冲突").closest("details")!.open).toBe(false);
});
