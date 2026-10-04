// @vitest-environment jsdom
import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { Dropdown } from "./Dropdown";
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);
describe("自绘选择器", () => {
  const options = [
    { value: "all", label: "所有分支" },
    { value: "main", label: "main", group: "本地分支" },
    { value: "feature", label: "feature", group: "本地分支" },
  ];
  it("搜索、键盘选择和关闭恢复焦点", async () => {
    const change = vi.fn();
    render(
      <Dropdown
        value="all"
        options={options}
        onChange={change}
        label="筛选历史"
        searchable
      />,
    );
    const trigger = screen.getByRole("button", { name: "筛选历史" });
    fireEvent.click(trigger);
    const input = await screen.findByRole("textbox", { name: "搜索筛选历史" });
    fireEvent.change(input, { target: { value: "feature" } });
    expect(screen.queryByRole("option", { name: "main" })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("feature");
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });
  it("Esc 不触发底层动作，退出后移除浮层", async () => {
    const change = vi.fn(),
      underlying = vi.fn();
    render(
      <div onKeyDown={underlying}>
        <Dropdown
          value="all"
          options={options}
          onChange={change}
          label="筛选历史"
          searchable
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "筛选历史" }));
    const input = await screen.findByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(change).not.toHaveBeenCalled();
    expect(underlying).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.querySelector("[data-menu-popup]")).toBeNull(),
    );
  });
  it("移除最近项目不会触发打开，Enter 和 Space 不会选中项目", async () => {
    const change = vi.fn();
    const remove = vi.fn().mockResolvedValue(true);
    render(
      <Dropdown
        value="repo"
        options={[
          { value: "repo", label: "repo", group: "最近打开", removable: true },
          { value: "other", label: "other" },
        ]}
        onChange={change}
        onRemoveOption={remove}
        label="项目"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "项目" }));
    const removeButton = await screen.findByRole("button", {
      name: "从最近打开移除 repo",
    });
    const option = screen.getByRole("option", { name: "repo" });
    expect(option.parentElement?.querySelectorAll("button")).toHaveLength(2);
    expect(option.contains(removeButton)).toBe(false);

    fireEvent.keyDown(removeButton, { key: "Enter" });
    fireEvent.keyDown(removeButton, { key: " " });
    expect(change).not.toHaveBeenCalled();

    fireEvent.click(removeButton);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("repo"));
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox", { name: "项目" })).toBeTruthy();
    expect(document.activeElement).toBe(
      document.querySelector(".dropdown-popup"),
    );
  });
  it("菜单关闭后迟到的移除结果不抢回焦点", async () => {
    let resolveRemoval!: (removed: boolean) => void;
    const remove = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRemoval = resolve;
        }),
    );
    render(
      <Dropdown
        value="repo"
        options={[{ value: "repo", label: "repo", removable: true }]}
        onChange={() => {}}
        onRemoveOption={remove}
        label="项目"
      />,
    );
    const trigger = screen.getByRole("button", { name: "项目" });
    fireEvent.click(trigger);
    const removeButton = await screen.findByRole("button", {
      name: "从最近打开移除 repo",
    });
    fireEvent.click(removeButton);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("repo"));
    fireEvent.keyDown(removeButton, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    resolveRemoval(true);
    await waitFor(() =>
      expect(document.querySelector("[data-menu-popup]")).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });
});
