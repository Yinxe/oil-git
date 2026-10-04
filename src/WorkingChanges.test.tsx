// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChangesSidebar } from "./WorkingChanges";
import type { FileState } from "./types";
import type { WorkingFile } from "./useWorkingCopy";

const makeFile = (
  path: string,
  options: Partial<FileState> = {},
): FileState => ({
  path,
  oldPath: null,
  xy: " M",
  conflict: false,
  untracked: false,
  staged: false,
  unstaged: true,
  ...options,
});

function StatefulSidebar({ files }: { files: FileState[] }) {
  const [file, setFile] = useState<WorkingFile | null>(null);
  return <ChangesSidebar files={files} file={file} onFile={setFile} />;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("更改目录树", () => {
  it("根目录文件直接显示，连续单目录链合并，文件名只显示 basename", () => {
    const files = [
      makeFile("README.md"),
      makeFile("apps/mobile/src/main.tsx"),
      makeFile("apps/mobile/src/routes/home.tsx"),
    ];
    render(<ChangesSidebar files={files} file={null} onFile={() => {}} />);

    const rootFile = screen.getByRole("button", {
      name: "README.md · 未暂存",
    });
    const nestedFile = screen.getByRole("button", {
      name: "apps/mobile/src/main.tsx · 未暂存",
    });
    expect(rootFile.closest(".change-directory")).toBeNull();
    expect(rootFile.querySelector(".source-file-name")?.textContent).toBe(
      "README.md",
    );
    expect(nestedFile.querySelector(".source-file-name")?.textContent).toBe(
      "main.tsx",
    );
    expect(nestedFile.getAttribute("title")).toBe("apps/mobile/src/main.tsx");
    expect(
      screen
        .getByRole("button", { name: "apps/mobile/src" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "apps/mobile/src/routes" }),
    ).toBeTruthy();
  });

  it("同一路径的暂存与未暂存选择独立，目录折叠在刷新后保留", () => {
    const files = [makeFile("src/shared.ts", { staged: true, xy: "MM" })];
    const view = render(<StatefulSidebar files={files} />);
    const folders = screen.getAllByRole("button", { name: "src" });

    fireEvent.click(folders[0]);
    expect(folders[0].getAttribute("aria-expanded")).toBe("false");
    expect(folders[1].getAttribute("aria-expanded")).toBe("true");

    view.rerender(
      <StatefulSidebar files={files.map((file) => ({ ...file }))} />,
    );
    const refreshedFolders = screen.getAllByRole("button", { name: "src" });
    expect(refreshedFolders[0].getAttribute("aria-expanded")).toBe("false");
    expect(refreshedFolders[1].getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(refreshedFolders[0]);
    const staged = screen.getByRole("button", {
      name: "src/shared.ts · 已暂存",
    });
    const unstaged = screen.getByRole("button", {
      name: "src/shared.ts · 未暂存",
    });
    fireEvent.click(staged);
    expect(staged.classList.contains("selected")).toBe(true);
    expect(unstaged.classList.contains("selected")).toBe(false);
    fireEvent.click(unstaged);
    expect(staged.classList.contains("selected")).toBe(false);
    expect(unstaged.classList.contains("selected")).toBe(true);

    const expandedFolder = screen.getAllByRole("button", { name: "src" })[0];
    view.rerender(<StatefulSidebar files={files} />);
    expect(screen.getAllByRole("button", { name: "src" })[0]).toBe(
      expandedFolder,
    );
    expect(screen.getByRole("button", { name: "src/shared.ts · 未暂存" })).toBe(
      unstaged,
    );
    expect(unstaged.classList.contains("selected")).toBe(true);
  });
});
