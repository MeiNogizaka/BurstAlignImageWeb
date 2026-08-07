// Port of align.py's alpha post-processing + compositing:
// _suppress_low_confidence_alpha, _harden_alpha, _decontaminate_foreground,
// and composite_all_subjects (the only composite mode the original UI
// exposes -- composite_with_subject/pick_best_subject_frame are CLI-only in
// the original app and were deliberately left out of its UI, so they're
// left out here too).
import type { CV } from "./cvRuntime";
import { subjectAlphaMatte } from "./matte";

/** Zero out the faintest end of the matte and rescale the rest back up to fill 0-1.
 * Mutates `alpha` (CV_32FC1) in place. */
export function suppressLowConfidenceAlphaInPlace(alpha: any, floor: number): void {
  const data: Float32Array = alpha.data32F;
  const denom = 1 - floor;
  for (let i = 0; i < data.length; i++) {
    let v = (data[i] - floor) / denom;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    data[i] = v;
  }
}

/** Boost a soft alpha matte so anything above `threshold` renders fully opaque.
 * Mutates `alpha` (CV_32FC1) in place. */
export function hardenAlphaInPlace(alpha: any, threshold: number): void {
  const data: Float32Array = alpha.data32F;
  for (let i = 0; i < data.length; i++) {
    let v = data[i] / threshold;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    data[i] = v;
  }
}

/** Recover the subject's true color at a semi-transparent edge pixel: `F = (I - (1-a)*B) / a`,
 * clamped against amplifying background-estimate mismatch into an unbounded swing.
 *
 * Returns a plain `Uint8Array` (rows*cols*3, BGR-interleaved) rather than a `cv.Mat` -- its
 * only consumer is a plain per-pixel JS loop, never another OpenCV call, so there's no reason
 * to spend WASM-heap-resident memory on it. See `compositeAllSubjects` for why that heap is
 * scarce enough to matter (it has a fixed ceiling well below the browser tab's regular JS heap,
 * and holding one of these per frame is what was exhausting it on large real-world photos). */
export function decontaminateForeground(
  frameBgr: any,
  alphaArr: Float32Array,
  backgroundBgr: any,
  floor = 0.25,
  maxCorrection = 60.0,
): Uint8Array {
  const rows = frameBgr.rows;
  const cols = frameBgr.cols;
  const n = rows * cols;
  const out = new Uint8Array(n * 3);
  const frameData: Uint8Array = frameBgr.data;
  const bgData: Uint8Array = backgroundBgr.data;

  for (let i = 0; i < n; i++) {
    const a = Math.max(floor, Math.min(1, alphaArr[i]));
    const base = i * 3;
    for (let c = 0; c < 3; c++) {
      const f = frameData[base + c];
      const b = bgData[base + c];
      const rawDecontaminated = (f - (1 - a) * b) / a;
      let delta = rawDecontaminated - f;
      delta = delta < -maxCorrection ? -maxCorrection : delta > maxCorrection ? maxCorrection : delta;
      let v = f + delta;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      out[base + c] = v; // truncates, matching `np.clip(...).astype(np.uint8)`
    }
  }
  return out;
}

export interface CompositeAllOptions {
  extraFeather: number;
  forceOpaque: boolean;
  overlapPriority: "first" | "last";
  edgeNoiseFloor: number;
  opacityThreshold: number;
  decontaminate: boolean;
  decontamMaxCorrection: number;
  confidentAlphaThreshold: number;
  overlapBlendSigmaPx: number;
}

/** Layer every frame's segmented subject onto `backgroundBgr` in one image (motion-sequence /
 * stroboscopic style). `masks` (the cheap diff-based pre-filter from detect.ts) decides which
 * frames are worth running the expensive matte model on at all. Returns null composite with
 * usedCount 0 if no frame had a detected subject.
 *
 * Per-frame alpha mattes and blended-ownership weights are kept as plain JS `Float32Array`s
 * (regular JS heap) rather than `cv.Mat`s (OpenCV's own WASM linear memory) everywhere except
 * the couple of operations -- the matte itself, and the ownership-mask Gaussian blur -- that
 * genuinely need OpenCV. That WASM heap has a fixed ceiling well below what a browser tab's
 * regular JS heap can hold; holding one CV_32FC1 Mat per frame (needed simultaneously for the
 * per-pixel "which frame owns this pixel" comparison across all frames) was enough to exhaust
 * it on real multi-frame bursts at full camera resolution. */
export async function compositeAllSubjects(
  cv: CV,
  ort: any,
  session: any,
  backgroundBgr: any,
  framesBgr: any[],
  masks: any[],
  opts: CompositeAllOptions,
  onFrameDone?: (current: number, total: number) => void,
): Promise<{ composite: any; usedCount: number }> {
  const rows = backgroundBgr.rows;
  const cols = backgroundBgr.cols;
  const n0 = framesBgr.length;
  const planeSize = rows * cols;

  const keptFrames: Uint8Array[] = [];
  const alphaArrays: Float32Array[] = [];

  for (let i = 0; i < n0; i++) {
    if (cv.countNonZero(masks[i]) > 0) {
      const alpha = await subjectAlphaMatte(cv, ort, session, framesBgr[i]);
      suppressLowConfidenceAlphaInPlace(alpha, opts.edgeNoiseFloor);
      if (opts.forceOpaque) hardenAlphaInPlace(alpha, opts.opacityThreshold);
      if (opts.extraFeather > 0) {
        cv.GaussianBlur(alpha, alpha, new cv.Size(0, 0), opts.extraFeather);
      }
      const alphaArr = new Float32Array(alpha.data32F);
      alpha.delete();

      keptFrames.push(
        opts.decontaminate
          ? decontaminateForeground(framesBgr[i], alphaArr, backgroundBgr, 0.25, opts.decontamMaxCorrection)
          : framesBgr[i].data,
      );
      alphaArrays.push(alphaArr);
    }
    onFrameDone?.(i + 1, n0);
  }

  if (keptFrames.length === 0) {
    return { composite: backgroundBgr.clone(), usedCount: 0 };
  }

  const n = keptFrames.length;

  const owner = new Int32Array(planeSize);
  const paintAlpha = new Float32Array(planeSize);

  for (let p = 0; p < planeSize; p++) {
    let chosen = opts.overlapPriority === "first" ? n : -1;
    let hasConfident = false;
    let maxA = -1;
    let maxIdx = 0;
    for (let i = 0; i < n; i++) {
      const a = alphaArrays[i][p];
      if (a > maxA) {
        maxA = a;
        maxIdx = i;
      }
      if (a > opts.confidentAlphaThreshold) {
        hasConfident = true;
        if (opts.overlapPriority === "first") {
          if (i < chosen) chosen = i;
        } else if (i > chosen) {
          chosen = i;
        }
      }
      if (a > paintAlpha[p]) paintAlpha[p] = a;
    }
    owner[p] = hasConfident ? chosen : maxIdx;
  }

  // Per-frame ownership mask, Gaussian-blurred so a genuine overlap boundary blends smoothly
  // instead of switching color hard at the exact per-pixel decision line, then re-weighted by
  // that frame's own alpha so a frame with no real subject content nearby never bleeds in.
  // Each Mat is transient -- copied into a plain array and deleted before moving to the next i,
  // instead of holding all N simultaneously.
  const totalWeight = new Float32Array(planeSize);
  const weightArrays: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const ownerMask = new cv.Mat(rows, cols, cv.CV_32FC1);
    const omData: Float32Array = ownerMask.data32F;
    for (let p = 0; p < planeSize; p++) omData[p] = owner[p] === i ? 1 : 0;

    let weightMat = ownerMask;
    if (opts.overlapBlendSigmaPx > 0) {
      const blurred = new cv.Mat();
      cv.GaussianBlur(ownerMask, blurred, new cv.Size(0, 0), opts.overlapBlendSigmaPx);
      ownerMask.delete();
      weightMat = blurred;
    }
    const wData: Float32Array = weightMat.data32F;
    const aData = alphaArrays[i];
    const wArr = new Float32Array(planeSize);
    for (let p = 0; p < planeSize; p++) {
      const w = wData[p] * aData[p];
      wArr[p] = w;
      totalWeight[p] += w;
    }
    weightMat.delete();
    weightArrays.push(wArr);
  }

  const color = new Float32Array(planeSize * 3);
  for (let i = 0; i < n; i++) {
    const wArr = weightArrays[i];
    const frameData = keptFrames[i];
    for (let p = 0; p < planeSize; p++) {
      const tw = totalWeight[p];
      const nw = tw > 1e-6 ? wArr[p] / tw : wArr[p];
      const base = p * 3;
      color[base] += frameData[base] * nw;
      color[base + 1] += frameData[base + 1] * nw;
      color[base + 2] += frameData[base + 2] * nw;
    }
  }

  const composite = new cv.Mat(rows, cols, backgroundBgr.type());
  const outData: Uint8Array = composite.data;
  const bgData: Uint8Array = backgroundBgr.data;
  for (let p = 0; p < planeSize; p++) {
    const a = paintAlpha[p];
    const base = p * 3;
    for (let c = 0; c < 3; c++) {
      let v = bgData[base + c] * (1 - a) + color[base + c] * a;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      outData[base + c] = v;
    }
  }

  return { composite, usedCount: n };
}
