// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorMessage } from "./ErrorMessage";
import {
  detectLanguage,
  localizedErrorSummary,
  LanguageProvider,
  loadLanguage,
  translate,
  useI18n,
} from "./i18n";
import type { GitError } from "./types";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("界面语言", () => {
  it("未知文案键不读取对象原型", () => {
    for (const key of ["toString", "constructor", "__proto__"]) {
      expect(translate("en", key, {})).toBe(key);
      expect(localizedErrorSummary("en", { messageKey: key })).toBe(
        "The read failed. Try again.",
      );
      expect(localizedErrorSummary("zh-CN", { messageKey: key })).toBe(
        "读取失败。请重试。",
      );
    }
  });

  it("英文计数使用单复数，中文计数保持自然表达", () => {
    expect(translate("en", "{count} 个文件", { count: 1 })).toBe("1 file");
    expect(translate("en", "{count} 个文件", { count: 2 })).toBe("2 files");
    expect(translate("en", "已加载 {count} 个提交", { count: 1 })).toBe(
      "Loaded 1 commit",
    );
    expect(translate("en", "暂停 · {count} 个冲突文件", { count: 1 })).toBe(
      "Paused · 1 conflicted file",
    );
    expect(translate("zh-CN", "{count} 个文件", { count: 1 })).toBe("1 个文件");
  });

  it("插值不再解释仓库参数中的占位文本", () => {
    expect(
      translate("en", "读取 {old} 失败，当前显示 {new} 的内容。", {
        old: "{new}",
        new: "main",
      }),
    ).toBe("Could not read {new}; showing content from main.");
  });

  it("按系统语言识别中文，其余语言使用英文", () => {
    expect(detectLanguage("zh-Hant-TW")).toBe("zh-CN");
    expect(detectLanguage("en-GB")).toBe("en");
    expect(detectLanguage(null)).toBe("en");
    vi.stubGlobal("navigator", { language: "zh-CN" });
    expect(loadLanguage()).toBe("zh-CN");
  });

  it("优先恢复保存的选择，切换时即时更新并持久化", () => {
    localStorage.setItem("oil-git.language", "zh-CN");
    function Harness() {
      const { language, setLanguage, t } = useI18n();
      return (
        <button onClick={() => setLanguage("en")}>
          {t("分支")} / {language}
        </button>
      );
    }
    const view = render(
      <LanguageProvider>
        <Harness />
      </LanguageProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("分支 / zh-CN");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("History / en");
    expect(localStorage.getItem("oil-git.language")).toBe("en");
    view.unmount();
    render(
      <LanguageProvider>
        <Harness />
      </LanguageProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("History / en");
  });

  it("动态插值保留参数，英语错误摘要提供可展开的原始诊断", () => {
    expect(
      translate("en", "读取 {old} 失败，当前显示 {new} 的内容。", {
        old: "abc12345",
        new: "def67890",
      }),
    ).toBe("Could not read abc12345; showing content from def67890.");
    const error: GitError = {
      kind: "unsafeFilter",
      messageKey: "unsafeFilter",
      message:
        "此仓库启用了可能写入文件的 Git clean/process 过滤器（demo），无法在只读模式下查看。",
    };
    function Harness() {
      const { setLanguage } = useI18n();
      return (
        <>
          <button onClick={() => setLanguage("en")}>English</button>
          <button onClick={() => setLanguage("zh-CN")}>简体中文</button>
          <ErrorMessage error={error} />
        </>
      );
    }
    render(
      <LanguageProvider>
        <Harness />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(
      screen.getByText(
        "This Git content filter is unsupported and cannot be read safely.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("View original diagnostic")).toBeTruthy();
    expect(screen.getByText(error.message)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "简体中文" }));
    expect(
      screen.getByText("Git 文件过滤器不受支持，无法安全读取。"),
    ).toBeTruthy();
    expect(screen.getByText("查看原始诊断")).toBeTruthy();
    expect(screen.getByText(error.message)).toBeTruthy();
  });

  it("实际 Rust 错误种类都有英文摘要", () => {
    const kinds = [
      "arguments",
      "bare",
      "binary",
      "changed",
      "changing",
      "config",
      "conflict",
      "git",
      "gitMissing",
      "gitUnavailable",
      "invalid",
      "lfsAttributeSourceUnsupported",
      "lfsHelper",
      "missing",
      "missingReference",
      "notRepository",
      "open",
      "partialCloneUnsupported",
      "path",
      "process",
      "read",
      "recent",
      "session",
      "staleHistory",
      "symlink",
      "timeout",
      "tooLarge",
      "unsafeFilter",
      "unsafePath",
      "unsupportedLfsExtension",
      "watch",
      "io",
      "desktopRequired",
    ];
    for (const kind of kinds) {
      expect(
        localizedErrorSummary("en", {
          kind,
          messageKey: kind,
          message: "原始错误诊断",
        }),
      ).not.toMatch(/\p{Script=Han}/u);
    }
  });
});
