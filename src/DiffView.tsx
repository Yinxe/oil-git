import { useEffect, useState } from "react";
import type { Diff, ConflictLine, DiffOrigin } from "./types";
import { LineAttribution } from "./LineAttribution";
import { CodeDiff, CodeLines } from "./CodeDiff";
import { FilePreviewDiff } from "./FilePreview";
import "./lfs-diff.css";
export { patchRows } from "./patch";

function Patch({ patch }: { patch: string }) {
  return <CodeDiff patch={patch} layout="unified" includeMetadata />;
}
function ConflictCode({
  rows,
  label,
}: {
  rows: ConflictLine[];
  label: string;
}) {
  return rows.length ? (
    <CodeLines lines={rows} label={label} />
  ) : (
    <p className="inline-note">这部分内容为空。</p>
  );
}
function LfsDiff({ data, labels }: { data: Diff; labels: [string, string] }) {
  const lfs = data.lfs!;
  const states = [lfs.beforeState, lfs.afterState];
  return (
    <section className="lfs-diff" aria-label="Git LFS 对象变化">
      <header>
        <h3>
          Git LFS
          {lfs.conflict && (
            <span className="lfs-conflict-state">未解决冲突</span>
          )}
        </h3>
        <p>Git 保存的是文件指针。此处显示对象信息，不下载文件内容。</p>
      </header>
      <div className="lfs-sides">
        {[lfs.before, lfs.after].map((pointer, index) => (
          <section className="lfs-side" key={index} aria-label={labels[index]}>
            <h4>{labels[index]}</h4>
            {pointer ? (
              <dl>
                <dt>大小</dt>
                <dd>
                  {new Intl.NumberFormat("zh-CN").format(pointer.size)} 字节
                </dd>
                <dt>SHA-256</dt>
                <dd>
                  <code>{pointer.oid}</code>
                </dd>
              </dl>
            ) : (
              <p>
                {states[index] === "missing"
                  ? "文件不存在"
                  : states[index] === "regular"
                    ? "此侧是普通文件内容"
                    : states[index] === "unsupported"
                      ? "此侧不是受支持的 LFS 指针"
                      : "无 LFS 对象"}
              </p>
            )}
          </section>
        ))}
      </div>
      {data.note && <p className="lfs-note">{data.note}</p>}
      {data.patch && (
        <details className="raw-diff">
          <summary>{lfs.conflict ? "原始指针冲突" : "原始指针差异"}</summary>
          <Patch patch={data.patch} />
        </details>
      )}
    </section>
  );
}
export function DiffView({
  data,
  layout = "unified",
  labels,
  origin,
  active = true,
}: {
  data: Diff;
  layout?: "split" | "unified";
  labels?: [string, string];
  origin?: DiffOrigin;
  active?: boolean;
}) {
  const [line, setLine] = useState<{
    side: "before" | "after";
    line: number;
  } | null>(null);
  const originKey = JSON.stringify(origin);
  useEffect(() => {
    setLine(null);
  }, [originKey, data.patch]);
  const selectLine =
    origin && (!data.encoding || data.encoding === "UTF-8")
      ? (side: "before" | "after", number: number) =>
          setLine({ side, line: number })
      : undefined;
  return (
    <div
      className={
        "diff-result " +
        (!data.conflict &&
        !data.lfs &&
        !data.preview &&
        !(data.note && data.patch)
          ? "virtual-diff"
          : "")
      }
    >
      {data.lfs ? (
        <LfsDiff
          data={data}
          labels={
            data.lfs.conflict
              ? ["当前分支", "合入分支"]
              : (labels ?? ["变更前", "变更后"])
          }
        />
      ) : data.preview ? (
        <FilePreviewDiff
          preview={data.preview}
          patch={data.patch}
          note={data.note}
          encoding={data.encoding}
          active={active}
          labels={data.preview.conflict ? ["当前分支", "合入分支"] : labels}
        />
      ) : data.conflict ? (
        <>
          <p className="diff-caption">{data.conflict.kind}</p>
          {data.conflict.blocks.map((b, i) => (
            <section className="conflict-block" key={b.startLine}>
              <h3>
                冲突 {i + 1}{" "}
                <span>
                  第 {b.startLine}–{b.endLine} 行
                </span>
              </h3>
              <div className="conflict-label">当前分支的内容</div>
              <ConflictCode rows={b.ours} label="当前分支的内容" />
              {b.base.length > 0 && (
                <details>
                  <summary>共同起点</summary>
                  <ConflictCode rows={b.base} label="共同起点" />
                </details>
              )}
              <div className="conflict-label incoming">
                合入的内容 {b.incoming && <span>· {b.incoming}</span>}
              </div>
              <ConflictCode rows={b.theirs} label="合入的内容" />
            </section>
          ))}
          {data.conflict.note && (
            <p className="inline-note">{data.conflict.note}</p>
          )}
          <details className="raw-diff">
            <summary>Git 原始差异</summary>
            <Patch patch={data.patch} />
          </details>
        </>
      ) : data.binary ? (
        <p className="inline-note">二进制文件发生变化，无法显示文本差异。</p>
      ) : data.patch && data.note ? (
        <section className="unconfirmed-diff">
          <p className="inline-note" role="status">
            {data.note}
          </p>
          <details className="raw-diff">
            <summary>Git 原始差异</summary>
            <Patch patch={data.patch} />
          </details>
        </section>
      ) : data.patch ? (
        <>
          {origin && line && (
            <LineAttribution
              origin={origin}
              selection={line}
              onClose={() => setLine(null)}
              active={active}
            />
          )}
          {data.encoding && (
            <p className="encoding-note">{data.encoding} · 按文本比较</p>
          )}
          <CodeDiff
            patch={data.patch}
            layout={layout}
            labels={labels}
            onLineSelect={selectLine}
          />
        </>
      ) : (
        <p className="inline-note">{data.note || "当前比较范围没有差异。"}</p>
      )}
      {data.truncated && (
        <p className="inline-note">差异较大，仅展示前 240 KB。</p>
      )}
    </div>
  );
}
