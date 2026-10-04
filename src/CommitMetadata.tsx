import { useState } from "react";
import { Collapse } from "./Collapse";
import { Icon } from "./Icon";
import type { CommitDetail } from "./types";

export function CommitMetadata({ detail }: { detail: CommitDetail }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="commit-metadata">
      <button
        className="commit-metadata-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon name="right" size={14} />
        <span>提交信息</span>
      </button>
      <Collapse expanded={expanded} className="commit-metadata-fold">
        <div className="commit-metadata-card">
          <dl className="commit-identity">
            <div>
              <dt>作者</dt>
              <dd>{detail.author}</dd>
            </div>
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
              </dd>
            </div>
            <div>
              <dt>父提交</dt>
              <dd>
                {detail.parents.length
                  ? detail.parents.map((parent) => (
                      <code key={parent} title={parent}>
                        {parent.slice(0, 8)}
                      </code>
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
