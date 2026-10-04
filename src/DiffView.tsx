import type { Diff, ConflictLine } from "./types";
import { CodeDiff, CodeLines } from "./CodeDiff";
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
export function DiffView({
  data,
  layout = "unified",
  labels,
}: {
  data: Diff;
  layout?: "split" | "unified";
  labels?: [string, string];
}) {
  return (
    <div className={"diff-result " + (!data.conflict ? "virtual-diff" : "")}>
      {data.conflict ? (
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
      ) : data.patch ? (
        <CodeDiff patch={data.patch} layout={layout} labels={labels} />
      ) : (
        <p className="inline-note">{data.note || "当前比较范围没有差异。"}</p>
      )}
      {data.truncated && (
        <p className="inline-note">差异较大，仅展示前 240 KB。</p>
      )}
    </div>
  );
}
