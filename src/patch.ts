export function patchRows(patch: string) {
  let old = 0,
    next = 0,
    hunk = false,
    combined = 0;
  return patch.split("\n").map((text) => {
    let kind = "meta",
      a: number | string = "",
      b: number | string = "";
    const match = text.match(
      /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@/,
    );
    if (text.startsWith("diff ")) {
      hunk = false;
      combined = 0;
    } else if (text.startsWith("@@@")) {
      hunk = true;
      combined = text.match(/^@+/)![0].length - 1;
      next = Number(text.match(/ \+([0-9]+)/)?.[1] || 0);
      kind = "hunk";
    } else if (match) {
      old = Number(match[1]);
      next = Number(match[2]);
      hunk = true;
      combined = 0;
      kind = "hunk";
    } else if (hunk && text.startsWith("\\")) {
      kind = "meta";
    } else if (hunk && combined) {
      const prefix = text.slice(0, combined);
      kind = prefix.includes("+")
        ? "add"
        : prefix.includes("-")
          ? "remove"
          : "context";
      if (!prefix.includes("-")) b = next++;
    } else if (hunk && text.startsWith("+")) {
      kind = "add";
      b = next++;
    } else if (hunk && text.startsWith("-")) {
      kind = "remove";
      a = old++;
    } else if (hunk && text.startsWith(" ")) {
      kind = "context";
      a = old++;
      b = next++;
    }
    return { text, kind, a, b };
  });
}
