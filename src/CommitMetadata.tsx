import { useState } from "react";
import { Collapse } from "./Collapse";
import { Icon } from "./Icon";
import { CopyButton } from "./CopyButton";
import type { CommitDetail } from "./types";
import { useI18n } from "./i18n";

export function CommitMetadata({ detail }: { detail: CommitDetail }) {
  const [expanded, setExpanded] = useState(false);
  const { t, language } = useI18n();
  return (
    <div className="commit-metadata">
      <div className="commit-metadata-heading">
        <button
          className="commit-metadata-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name="right" size={14} />
          <span>{t("提交信息")}</span>
        </button>
        <CopyButton
          label={t("复制提交信息")}
          text={[
            t("提交：{value}", { value: detail.subject }),
            `ID：${detail.hash}`,
            t("作者：{value}", {
              value: `${detail.author}${detail.authorEmail ? ` <${detail.authorEmail}>` : ""}`,
            }),
            ...(detail.committer
              ? [
                  t("提交者：{value}", {
                    value: `${detail.committer}${detail.committerEmail ? ` <${detail.committerEmail}>` : ""}`,
                  }),
                ]
              : []),
            t("时间：{value}", { value: detail.date }),
            t("父提交：{value}", {
              value: detail.parents.join(", ") || t("无"),
            }),
            t("比较：{value}", { value: t(detail.comparison) }),
            t("变更文件："),
            ...detail.files.map(
              (file) =>
                `${file.status} ${file.path}${file.oldPath ? ` ← ${file.oldPath}` : ""}`,
            ),
          ].join("\n")}
        />
      </div>
      <Collapse expanded={expanded} className="commit-metadata-fold">
        <div className="commit-metadata-card">
          <dl className="commit-identity">
            <div>
              <dt>{t("作者")}</dt>
              <dd>
                {detail.author}
                {detail.authorEmail && (
                  <span className="author-email">{detail.authorEmail}</span>
                )}
              </dd>
            </div>
            {detail.committer &&
              (detail.committer !== detail.author ||
                detail.committerEmail !== detail.authorEmail) && (
                <div>
                  <dt>{t("提交者")}</dt>
                  <dd>
                    {detail.committer}
                    {detail.committerEmail && (
                      <span className="author-email">
                        {detail.committerEmail}
                      </span>
                    )}
                  </dd>
                </div>
              )}
            <div>
              <dt>{t("时间")}</dt>
              <dd>
                {new Date(detail.date).toLocaleString(
                  language === "en" ? "en-US" : "zh-CN",
                )}
              </dd>
            </div>
          </dl>
          <dl className="commit-references">
            <div>
              <dt>{t("提交 ID")}</dt>
              <dd>
                <code>{detail.hash}</code>
                <CopyButton text={detail.hash} label={t("复制完整提交 ID")} />
              </dd>
            </div>
            <div>
              <dt>{t("父提交")}</dt>
              <dd>
                {detail.parents.length
                  ? detail.parents.map((parent) => (
                      <span className="copy-value" key={parent}>
                        <code title={parent}>{parent.slice(0, 8)}</code>
                        <CopyButton text={parent} label={t("复制父提交 ID")} />
                      </span>
                    ))
                  : t("首次提交")}
              </dd>
            </div>
          </dl>
        </div>
      </Collapse>
    </div>
  );
}
