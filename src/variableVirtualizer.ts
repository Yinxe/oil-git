export type VirtualRange = {
  start: number;
  end: number;
  offset: number;
  totalHeight: number;
};

export type ScrollAnchor = { index: number; offset: number };

/** Prefix-sum index for variable-height rows. Updates and range lookup are O(log n). */
export class VariableHeightIndex {
  private heights: Float64Array;
  private heightGenerations: Uint32Array;
  private tree: Float64Array;
  private treeGenerations: Uint32Array;
  private generation = 1;

  constructor(
    readonly count: number,
    readonly estimate = 24,
  ) {
    this.heights = new Float64Array(count);
    this.heightGenerations = new Uint32Array(count);
    this.tree = new Float64Array(count + 1);
    this.treeGenerations = new Uint32Array(count + 1);
  }

  /** Invalidate measurements in O(1), which keeps continuous resizing cheap. */
  reset() {
    if (this.generation === 0xffff_ffff) {
      this.heightGenerations.fill(0);
      this.treeGenerations.fill(0);
      this.generation = 1;
    } else {
      this.generation++;
    }
  }

  heightAt(index: number) {
    if (index < 0 || index >= this.count) return 0;
    return this.heightGenerations[index] === this.generation
      ? this.heights[index]
      : this.estimate;
  }

  setHeight(index: number, height: number) {
    if (index < 0 || index >= this.count || !Number.isFinite(height))
      return false;
    const next = Math.max(this.estimate, Math.ceil(height));
    const delta = next - this.heightAt(index);
    if (Math.abs(delta) < 0.5) return false;
    this.heights[index] = next;
    this.heightGenerations[index] = this.generation;
    for (let i = index + 1; i <= this.count; i += i & -i) {
      if (this.treeGenerations[i] !== this.generation) {
        this.tree[i] = 0;
        this.treeGenerations[i] = this.generation;
      }
      this.tree[i] += delta;
    }
    return true;
  }

  /** Sum of rows in [0, end). */
  prefix(end: number) {
    const endIndex = Math.max(0, Math.min(this.count, Math.floor(end)));
    let i = endIndex;
    let sum = 0;
    for (; i > 0; i -= i & -i) {
      if (this.treeGenerations[i] === this.generation) sum += this.tree[i];
    }
    return this.estimate * endIndex + sum;
  }

  get totalHeight() {
    return this.prefix(this.count);
  }

  indexAt(offset: number) {
    if (this.count === 0) return 0;
    const target = Math.max(0, Math.min(offset, this.totalHeight - 0.001));
    let index = 0;
    let sum = 0;
    let step = 1;
    while (step * 2 <= this.count) step *= 2;
    for (; step > 0; step = Math.floor(step / 2)) {
      const next = index + step;
      const delta =
        next <= this.count && this.treeGenerations[next] === this.generation
          ? this.tree[next]
          : 0;
      if (next <= this.count && this.estimate * next + sum + delta <= target) {
        index = next;
        sum += delta;
      }
    }
    return Math.min(index, this.count - 1);
  }

  anchorAt(offset: number): ScrollAnchor {
    if (this.count === 0) return { index: 0, offset: 0 };
    const index = this.indexAt(offset);
    return { index, offset: Math.max(0, offset - this.prefix(index)) };
  }

  offsetForAnchor(anchor: ScrollAnchor) {
    if (this.count === 0) return 0;
    const index = Math.max(0, Math.min(anchor.index, this.count - 1));
    const withinRow = Math.min(
      Math.max(0, anchor.offset),
      Math.max(0, this.heightAt(index) - 1),
    );
    return this.prefix(index) + withinRow;
  }

  range(scrollTop: number, viewportHeight: number, overscan = 5): VirtualRange {
    if (this.count === 0)
      return { start: 0, end: 0, offset: 0, totalHeight: 0 };
    const top = Math.max(0, Math.min(scrollTop, this.totalHeight));
    const bottom = Math.max(top, top + Math.max(0, viewportHeight));
    const firstVisible = this.indexAt(top);
    const lastVisible = this.indexAt(Math.min(bottom, this.totalHeight));
    const start = Math.max(0, firstVisible - Math.max(0, overscan));
    const end = Math.min(
      this.count,
      Math.max(firstVisible + 1, lastVisible + 1) + Math.max(0, overscan),
    );
    return {
      start,
      end,
      offset: this.prefix(start),
      totalHeight: this.totalHeight,
    };
  }
}
