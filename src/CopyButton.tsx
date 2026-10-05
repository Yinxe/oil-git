import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Icon } from "./Icon";
import { useI18n } from "./i18n";

export function CopyButton({
  text,
  label,
  quiet = false,
}: {
  text: string;
  label: string;
  quiet?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const { t } = useI18n();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const serial = useRef(0);
  useEffect(() => {
    serial.current++;
    setStatus("idle");
    return () => {
      serial.current++;
      clearTimeout(timer.current);
    };
  }, [text]);
  const title =
    status === "copied"
      ? t("已复制")
      : status === "error"
        ? t("复制失败，点击重试")
        : label;
  return (
    <button
      type="button"
      className={"icon-button copy-button" + (quiet ? " copy-quiet" : "")}
      aria-label={label}
      title={title}
      data-status={status}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={async (event) => {
        event.stopPropagation();
        const ticket = ++serial.current;
        clearTimeout(timer.current);
        try {
          await writeText(text);
          if (ticket !== serial.current) return;
          setStatus("copied");
        } catch {
          if (ticket !== serial.current) return;
          setStatus("error");
        }
        timer.current = setTimeout(() => setStatus("idle"), 1800);
      }}
    >
      <Icon
        name={
          status === "copied" ? "check" : status === "error" ? "close" : "copy"
        }
        size={14}
      />
      {status !== "idle" && (
        <span className="sr-only" role="status">
          {title}
        </span>
      )}
    </button>
  );
}
