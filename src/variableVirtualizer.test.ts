import { describe, expect, it } from "vitest";
import { VariableHeightIndex } from "./variableVirtualizer";

describe("变高差异行索引", () => {
  it("按换行后的实测高度计算后续行位置和可见范围", () => {
    const index = new VariableHeightIndex(8, 24);
    index.setHeight(1, 72);
    index.setHeight(2, 48);

    expect(index.prefix(4)).toBe(168);
    expect(index.indexAt(24)).toBe(1);
    expect(index.range(80, 48, 0)).toMatchObject({
      start: 1,
      end: 3,
      offset: 24,
      totalHeight: 264,
    });
  });

  it("前面行高改变后保留顶部行及行内偏移", () => {
    const index = new VariableHeightIndex(100, 24);
    const anchor = index.anchorAt(50 * 24 + 6);
    expect(anchor).toEqual({ index: 50, offset: 6 });

    index.setHeight(2, 96);
    expect(index.offsetForAnchor(anchor)).toBe(50 * 24 + 72 + 6);
  });

  it("列宽变化惰性清空旧高度后仍可恢复同一行锚点", () => {
    const index = new VariableHeightIndex(100, 24);
    index.setHeight(12, 96);
    const anchor = index.anchorAt(index.prefix(40) + 7);
    index.reset();

    expect(index.offsetForAnchor(anchor)).toBe(40 * 24 + 7);
    expect(index.totalHeight).toBe(100 * 24);
  });

  it("十万行时范围查询只返回视口附近的行", () => {
    const index = new VariableHeightIndex(100_000, 24);
    index.setHeight(50_000, 96);
    const range = index.range(1_200_000, 600, 5);

    expect(range.start).toBeGreaterThan(49_900);
    expect(range.end - range.start).toBeLessThan(40);
    expect(range.totalHeight).toBe(2_400_072);
  });
});
