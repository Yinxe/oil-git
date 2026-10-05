import { useState } from "react";
import { Collapse } from "./Collapse";
import { Icon } from "./Icon";
import { CopyButton } from "./CopyButton";
import type { CommitDetail } from "./types";

export function CommitMetadata({ detail }: { detail: CommitDetail }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="commit-metadata">
      <div className="commit-metadata-heading">
        <button
          className="commit-metadata-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name="right" size={14} />
          <span>提交信息</span>
        </button>
        <CopyButton
          label="复制提交信息"
          text={[
            `提交：${detail.subject}`,
            `ID：${detail.hash}`,
            `作者：${detail.author}${detail.authorEmail ? ` <${detail.authorEmail}>` : ""}`,
            ...(detail.committer
              ? [
                  `提交者：${detail.committer}${detail.committerEmail ? ` <${detail.committerEmail}>` : ""}`,
                ]
              : []),
            `时间：${detail.date}`,
            `父提交：${detail.parents.join(", ") || "无"}`,
            `比较：${detail.comparison}`,
            "变更文件：",
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
              <dt>作者</dt>
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
                  <dt>提交者</dt>
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
              <dt>时间</dt>
              <dd>{new Date(detail.date).toLocaleString("zh-CN")}</dd>
            </div>
          </dl>
          <dl className="commit-references">
            <div>
              <dt>提交 ID</dt>
              <dd>
                <code>{detail.hash}</code>
                <CopyButton text={detail.hash} label="复制完整提交 ID" />
              </dd>
            </div>
            <div>
              <dt>父提交</dt>
              <dd>
                {detail.parents.length
                  ? detail.parents.map((parent) => (
                      <span className="copy-value" key={parent}>
                        <code title={parent}>{parent.slice(0, 8)}</code>
                        <CopyButton text={parent} label="复制父提交 ID" />
                      </span>
                    ))
                  : "首次提交"}
              </dd>
            </div>
          </dl>
        </div>
      </Collapse>
    </div>
  );
}
