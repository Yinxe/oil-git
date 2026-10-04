import { useEffect, useState } from "react";

// 快速读取不显示加载占位；较慢请求只在当前区域提示，避免闪烁与整屏明暗变化。
export function ReadStatus({
  busy = true,
  requestKey,
  label,
}: {
  busy?: boolean;
  requestKey: string;
  label: string;
}) {
  const [visibleKey, setVisibleKey] = useState<string | null>(null);
  useEffect(() => {
    setVisibleKey(null);
    if (!busy) return;
    const timer = setTimeout(() => setVisibleKey(requestKey), 200);
    return () => clearTimeout(timer);
  }, [busy, requestKey]);
  if (!busy || visibleKey !== requestKey) return null;
  return (
    <div className="read-status" role="status">
      {label}
    </div>
  );
}
