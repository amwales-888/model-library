'use strict';
// Which thumbnails are selected. A selection is kept as ranges of positions in the sorted list ([start, end], both
// included), not as a list of files, so selecting 50,000 files costs the same as selecting one and the grid only ever
// needs the rows that are on screen. Used by app.js in the browser and by the tests in Node.

class Selection {
  constructor() { this.ranges = []; this.anchor = null; }

  get count() { return this.ranges.reduce((n, [a, b]) => n + (b - a + 1), 0); }

  has(i) { return this.ranges.some(([a, b]) => i >= a && i <= b); }

  clear() { this.ranges = []; this.anchor = null; }

  /** Only item i is selected. */
  only(i) { this.ranges = [[i, i]]; this.anchor = i; }

  /** Adds item i if it is not selected, removes it if it is. */
  toggle(i) {
    if (this.has(i)) this._remove(i, i); else this._add(i, i);
    this.anchor = i;
  }

  /** Selects everything between the last clicked item (the anchor) and i. With `add`, keeps what was selected before. */
  extendTo(i, add = false) {
    if (this.anchor === null) { this.only(i); return; }
    const a = Math.min(this.anchor, i); const b = Math.max(this.anchor, i);
    if (!add) this.ranges = [];
    this._add(a, b);                     // the anchor stays where it was, so the range can be adjusted by shift-clicking again
  }

  all(total) { this.ranges = total > 0 ? [[0, total - 1]] : []; this.anchor = total > 0 ? 0 : null; }

  /** Drops anything beyond the end of a list that has become shorter. */
  clampTo(total) {
    this.ranges = this.ranges.filter(([a]) => a < total).map(([a, b]) => [a, Math.min(b, total - 1)]);
    if (this.anchor !== null && this.anchor >= total) this.anchor = null;
  }

  /** The selected positions in order, as { start, end } blocks. */
  blocks() { return this.ranges.map(([start, end]) => ({ start, end })); }

  _add(a, b) {
    const merged = [];
    let [start, end] = [a, b];
    for (const [x, y] of this.ranges) {
      if (y < start - 1 || x > end + 1) merged.push([x, y]);
      else { start = Math.min(start, x); end = Math.max(end, y); }
    }
    merged.push([start, end]);
    this.ranges = merged.sort((p, q) => p[0] - q[0]);
  }

  _remove(a, b) {
    const result = [];
    for (const [x, y] of this.ranges) {
      if (y < a || x > b) { result.push([x, y]); continue; }
      if (x < a) result.push([x, a - 1]);
      if (y > b) result.push([b + 1, y]);
    }
    this.ranges = result;
  }
}

if (typeof module !== 'undefined') module.exports = { Selection };
