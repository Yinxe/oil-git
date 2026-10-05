import { useEffect, useState } from "react";
import { useI18n } from "./i18n";

export function SyncIndicator({
  busy,
  requestKey,
}: {
  busy: boolean;
  requestKey: string;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState(document.visibilityState === "visible");
  const [visibleKey, setVisibleKey] = useState<string | null>(null);
  useEffect(() => {
    const visibility = () => setActive(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    setVisibleKey(null);
    if (!busy || !active) return;
    const timer = setTimeout(() => setVisibleKey(requestKey), 200);
    return () => clearTimeout(timer);
  }, [busy, active, requestKey]);
  if (!busy || !active || visibleKey !== requestKey) return null;
  return (
    <div
      className="sync-indicator"
      role="progressbar"
      aria-label={t("正在同步仓库")}
    />
  );
}
