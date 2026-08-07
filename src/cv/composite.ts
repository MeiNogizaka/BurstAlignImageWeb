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
 * clamped against amplifying background-estimate mismatch into an unbounded swing. */
export function decontaminateForeground(
  cv: CV,
  frameBgr: any,
  alpha: any,
  backgroundBgr: any,
  floor = 0.25,
  maxCorrection = 60.0,
): any {
  const rows = frameBgr.rows;
  const cols = frameBgr.cols;
  const out = new cv.Mat(rows, cols, frameBgr.type());
  const outData: Uint8Array = out.data;
  const frameData: Uint8Array = frameBgr.data;
  const bgData: Uint8Array = backgroundBgr.data;
  const alphaData: Float32Array = alpha.data32F;
  const n = rows * cols;

  for (let i = 0; i < n; i++) {
    const a = Math.max(floor, Math.min(1, alphaData[i]));
    const base = i * 3;
    for (let c = 0; c < 3; c++) {
      const f = frameData[base + c];
      const b = bgData[base + c];
      const rawDecontaminated = (f - (1 - a) * b) / a;
      let delta = rawDecontaminated - f;
      delta = delta < -maxCorrection ? -maxCorrection : delta > maxCorrection ? maxCorrection : delta;
      let v = f + delta;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      outData[base + c] = v; // truncates, matching `np.clip(...).astype(np.uint8)`
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
 * usedCount 0 if no frame had a detected subject. */
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

  const keptFrames: any[] = [];
  const keptFramesOwned: boolean[] = [];
  const alphas: any[] = [];

  for (let i = 0; i < n0; i++) {
    if (cv.countNonZero(masks[i]) > 0) {
      const alpha = await subjectAlphaMatte(cv, ort, session, framesBgr[i]);
      suppressLowConfidenceAlphaInPlace(alpha, opts.edgeNoiseFloor);
      if (opts.forceOpaque) hardenAlphaInPlace(alpha, opts.opacityThreshold);
      if (opts.extraFeather > 0) {
        cv.GaussianBlur(alpha, alpha, new cv.Size(0, 0), opts.extraFeather);
      }
      if (opts.decontaminate) {
        keptFrames.push(decontaminateForeground(cv, framesBgr[i], alpha, backgroundBgr, 0.25, opts.decontamMaxCorrection));
        keptFramesOwned.push(true);
      } else {
        keptFrames.push(framesBgr[i]);
        keptFramesOwned.push(false);
      }
      alphas.push(alpha);
    }
    onFrameDone?.(i + 1, n0);
  }

  if (keptFrames.length === 0) {
    return { composite: backgroundBgr.clone(), usedCount: 0 };
  }

  const n = keptFrames.length;
  const planeSize = rows * cols;
  const alphaArrays: Float32Array[] = alphas.map((a) => a.data32F);

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
  const weightMats: any[] = [];
  for (let i = 0; i < n; i++) {
    const ownerMask = new cv.Mat(rows, cols, cv.CV_32FC1);
    const omData: Float32Array = ownerMask.data32F;
    for (let p = 0; p < planeSize; p++) omData[p] = owner[p] === i ? 1 : 0;

    let weight = ownerMask;
    if (opts.overlapBlendSigmaPx > 0) {
      const blurred = new cv.Mat();
      cv.GaussianBlur(ownerMask, blurred, new cv.Size(0, 0), opts.overlapBlendSigmaPx);
      ownerMask.delete();
      weight = blurred;
    }
    const wData: Float32Array = weight.data32F;
    const aData = alphaArrays[i];
    for (let p = 0; p < planeSize; p++) wData[p] *= aData[p];
    weightMats.push(weight);
  }

  const totalWeight = new Float32Array(planeSize);
  for (let i = 0; i < n; i++) {
    const wData: Float32Array = weightMats[i].data32F;
    for (let p = 0; p < planeSize; p++) totalWeight[p] += wData[p];
  }

  const color = new Float32Array(planeSize * 3);
  for (let i = 0; i < n; i++) {
    const wData: Float32Array = weightMats[i].data32F;
    const frameData: Uint8Array = keptFrames[i].data;
    for (let p = 0; p < planeSize; p++) {
      const tw = totalWeight[p];
      const nw = tw > 1e-6 ? wData[p] / tw : wData[p];
      const base = p * 3;
      color[base] += frameData[base] * nw;
      color[base + 1] += frameData[base + 1] * nw;
      color[base + 2] += frameData[base + 2] * nw;
    }
  }
  for (const w of weightMats) w.delete();

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

  for (let i = 0; i < n; i++) {
    alphas[i].delete();
    if (keptFramesOwned[i]) keptFrames[i].delete();
  }

  return { composite, usedCount: n };
}
