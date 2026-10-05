import type { GitError } from "./types";
import { useI18n } from "./i18n";

export function ErrorMessage({ error }: { error: GitError }) {
  const { error: errorText, errorDiagnostic, t } = useI18n();
  const diagnostic = errorDiagnostic(error);
  return (
    <>
      <span>{errorText(error)}</span>
      {diagnostic && (
        <details className="error-diagnostic">
          <summary>{t("查看原始诊断")}</summary>
          <span>{diagnostic}</span>
        </details>
      )}
    </>
  );
}
