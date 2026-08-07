// Port of align.py's median_stack: per-pixel median across aligned, cropped
// frames, removing anything that moved (a moving subject leaves a signal at
// only a minority of frames at any given pixel, so the median rejects it).
import type { CV } from "./cvRuntime";

export function medianStack(cv: CV, mats: any[]): any {
  const n = mats.length;
  const rows = mats[0].rows;
  const cols = mats[0].cols;
  const channels = mats[0].channels();
  const size = rows * cols * channels;

  const out = new cv.Mat(rows, cols, mats[0].type());
  const outData: Uint8Array = out.data;
  const buffers: Uint8Array[] = mats.map((m) => m.data);

  const tmp = new Uint8Array(n);
  const mid = n >> 1;
  const even = n % 2 === 0;

  for (let i = 0; i < size; i++) {
    for (let k = 0; k < n; k++) tmp[k] = buffers[k][i];
    // insertion sort -- n is at most MAX_FILES (15), so this beats a generic
    // comparator sort's per-call overhead run size*channels times.
    for (let a = 1; a < n; a++) {
      const v = tmp[a];
      let b = a - 1;
      while (b >= 0 && tmp[b] > v) {
        tmp[b + 1] = tmp[b];
        b--;
      }
      tmp[b + 1] = v;
    }
    // np.median averages the two middle values for an even count, then
    // `.astype(np.uint8)` truncates (not rounds) the float result.
    outData[i] = even ? Math.floor((tmp[mid - 1] + tmp[mid]) / 2) : tmp[mid];
  }

  return out;
}
