// Port of align.py's foreground_mask/compute_foreground_masks: a cheap
// diff-based pre-filter for "does this frame show a moving subject, and
// roughly where" -- NOT the actual cutout (that's matte.ts via rembg/u2netp).
import type { CV } from "./cvRuntime";

/** numpy's default `linear`-interpolation percentile, computed via a 256-bin counting
 * sort since the input is always uint8 -- O(n) instead of an O(n log n) full sort. */
function percentileOf(data: Uint8Array, percentile: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;

  const n = data.length;
  const rank = (percentile / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;

  let cum = 0;
  let loVal = 0;
  let hiVal = 0;
  let loFound = false;
  let hiFound = false;
  for (let v = 0; v < 256; v++) {
    const nextCum = cum + hist[v];
    if (!loFound && lo < nextCum) {
      loVal = v;
      loFound = true;
    }
    if (!hiFound && hi < nextCum) {
      hiVal = v;
      hiFound = true;
    }
    if (loFound && hiFound) break;
    cum = nextCum;
  }
  return loVal + (hiVal - loVal) * frac;
}

export interface ForegroundMaskResult {
  mask: any; // cv.Mat, CV_8UC1, 0/255
  oversized: boolean;
}

export function foregroundMask(
  cv: CV,
  frameBgr: any,
  backgroundBgr: any,
  minAreaFrac = 0.0002,
  maxAreaFrac = 0.03,
  percentile = 97.0,
): ForegroundMaskResult {
  const rows = frameBgr.rows;
  const cols = frameBgr.cols;
  const n = rows * cols;

  // Lab conversion of an 8-bit BGR image is itself 8-bit -- align.py's `.astype(np.float32)`
  // right after doesn't add any precision, it only widens the storage type so the later
  // arithmetic (which can go negative or outside 0-255 before clipping) doesn't wrap around.
  // JS `number` is already double-precision, so reading straight out of the 8-bit buffers below
  // and doing the same arithmetic on plain numbers is numerically identical -- while skipping
  // two full-resolution 3-channel float32 copies (rows*cols*3*4 bytes each; ~240MB for a single
  // 24MP frame) that were large enough to exhaust OpenCV.js's WASM heap on real-world photos.
  const frameLab8 = new cv.Mat();
  cv.cvtColor(frameBgr, frameLab8, cv.COLOR_BGR2Lab);
  const bgLab8 = new cv.Mat();
  cv.cvtColor(backgroundBgr, bgLab8, cv.COLOR_BGR2Lab);

  const frameData: Uint8Array = frameLab8.data;
  const bgData: Uint8Array = bgLab8.data;

  // Least-squares fit of a global L-channel gain (a,b so that a*x+b ~= y),
  // sampled every 37th pixel -- matches _fit_linear_gain's `[::37]` on the
  // flattened, already-extracted L-only channel (not a stride into the raw
  // interleaved L/a/b buffer).
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  let m = 0;
  for (let i = 0; i < n; i += 37) {
    const x = frameData[i * 3];
    const y = bgData[i * 3];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
    m++;
  }
  const meanX = sumX / m;
  const meanY = sumY / m;
  const varX = sumXX / m - meanX * meanX;
  const covXY = sumXY / m - meanX * meanY;
  const gainA = varX === 0 ? 0 : covXY / varX;
  const gainB = meanY - gainA * meanX;

  const diffU8 = new cv.Mat(rows, cols, cv.CV_8UC1);
  const diffData: Uint8Array = diffU8.data;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    let l = gainA * frameData[o] + gainB;
    l = l < 0 ? 0 : l > 255 ? 255 : l;
    const dl = l - bgData[o];
    const da = frameData[o + 1] - bgData[o + 1];
    const db = frameData[o + 2] - bgData[o + 2];
    let d = Math.sqrt(dl * dl + da * da + db * db);
    d = d < 0 ? 0 : d > 255 ? 255 : d;
    diffData[i] = d; // truncates toward zero, matching `.astype(np.uint8)`
  }
  frameLab8.delete();
  bgLab8.delete();

  const blurred = new cv.Mat();
  cv.GaussianBlur(diffU8, blurred, new cv.Size(0, 0), 3);
  diffU8.delete();

  const threshVal = percentileOf(blurred.data as Uint8Array, percentile);

  const thresholded = new cv.Mat();
  cv.threshold(blurred, thresholded, threshVal, 255, cv.THRESH_BINARY);
  blurred.delete();

  const kernel = new cv.Mat(7, 7, cv.CV_8U, new cv.Scalar(1, 0, 0, 0));
  const opened = new cv.Mat();
  cv.morphologyEx(thresholded, opened, cv.MORPH_OPEN, kernel, new cv.Point(-1, -1), 1);
  thresholded.delete();
  const closed = new cv.Mat();
  cv.morphologyEx(opened, closed, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 5);
  opened.delete();
  kernel.delete();

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  hierarchy.delete();
  closed.delete();

  const filled = new cv.Mat(rows, cols, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0));
  cv.drawContours(filled, contours, -1, new cv.Scalar(255, 0, 0, 0), cv.FILLED);
  contours.delete();

  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  const numLabels = cv.connectedComponentsWithStats(filled, labels, stats, centroids, 8, cv.CV_32S);
  filled.delete();
  centroids.delete();

  const frameArea = rows * cols;
  const minArea = minAreaFrac * frameArea;
  const maxArea = maxAreaFrac * frameArea;

  const statsData: Int32Array = stats.data32S;
  const keepLabel = new Uint8Array(numLabels);
  let oversized = false;
  for (let i = 1; i < numLabels; i++) {
    const area = statsData[i * 5 + cv.CC_STAT_AREA];
    if (area >= minArea && area <= maxArea) {
      keepLabel[i] = 1;
    } else if (area > maxArea) {
      oversized = true;
    }
  }

  const kept = new cv.Mat(rows, cols, cv.CV_8UC1, new cv.Scalar(0, 0, 0, 0));
  const keptData: Uint8Array = kept.data;
  const labelData: Int32Array = labels.data32S;
  for (let i = 0; i < frameArea; i++) {
    const label = labelData[i];
    if (label > 0 && keepLabel[label]) keptData[i] = 255;
  }
  labels.delete();
  stats.delete();

  return { mask: kept, oversized };
}
