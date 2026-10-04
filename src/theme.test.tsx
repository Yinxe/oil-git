// @vitest-environment jsdom
import { afterEach, it, expect } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ThemeProvider, useTheme, loadTheme } from "./theme";
import { fileIconPath } from "./FileIcon";
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
it("主题切换立即生效并在重新打开时恢复", () => {
  function Harness() {
    const { theme, setTheme } = useTheme();
    return <button onClick={() => setTheme("light")}>{theme}</button>;
  }
  const { unmount } = render(
    <ThemeProvider>
      <Harness />
    </ThemeProvider>,
  );
  expect(document.documentElement.dataset.theme).toBe("dark");
  fireEvent.click(screen.getByRole("button"));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(loadTheme()).toBe("light");
  unmount();
  render(
    <ThemeProvider>
      <Harness />
    </ThemeProvider>,
  );
  expect(screen.getByRole("button").textContent).toBe("light");
});
it("现成文件图标覆盖类型与特殊名称，未知文件有默认图标", () => {
  expect(fileIconPath("src/app.ts", "dark")).toContain("typescript.svg");
  expect(fileIconPath("src/App.tsx", "dark")).toContain("react_ts.svg");
  expect(fileIconPath("README.md", "dark")).not.toBe(
    fileIconPath("app.ts", "dark"),
  );
  expect(fileIconPath("package.json", "light")).toContain("nodejs");
  expect(fileIconPath("中文.unknown-extension", "dark")).toContain(
    "/file-icons/",
  );
});
