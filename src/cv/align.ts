// Port of align.py's feature-matching / homography / warp / crop-rect logic.
// Function names and defaults mirror the Python originals so the two can be
// diffed against each other.
import type { CV } from "./cvRuntime";

export interface Keypoints {
  keypoints: any; // cv.KeyPointVector
  descriptors: any; // cv.Mat
}

export interface DMatchLite {
  queryIdx: number;
  trainIdx: number;
  distance: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function toGrayClahe(cv: CV, bgr: any, clipLimit = 2.0, tileGrid: [number, number] = [8, 8]): any {
  const gray = new cv.Mat();
  cv.cvtColor(bgr, gray, cv.COLOR_BGR2GRAY);
  const clahe = new cv.CLAHE(clipLimit, new cv.Size(tileGrid[0], tileGrid[1]));
  const out = new cv.Mat();
  clahe.apply(gray, out);
  clahe.delete();
  gray.delete();
  return out;
}

export function downscaleForMatching(cv: CV, gray: any, maxSide = 1600): { mat: any; scale: number } {
  const h = gray.rows;
  const w = gray.cols;
  const scale = Math.min(1, maxSide / Math.max(h, w));
  if (scale >= 1) {
    return { mat: gray.clone(), scale: 1 };
  }
  const dsize = new cv.Size(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const out = new cv.Mat();
  cv.resize(gray, out, dsize, 0, 0, cv.INTER_AREA);
  return { mat: out, scale };
}

export function detectAndDescribe(cv: CV, gray: any, maxFeatures = 4000): Keypoints {
  const orb = new cv.ORB(maxFeatures);
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  const noMask = new cv.Mat();
  orb.detectAndCompute(gray, noMask, keypoints, descriptors);
  noMask.delete();
  orb.delete();
  return { keypoints, descriptors };
}

export function matchDescriptors(cv: CV, desRef: any, desI: any, ratio = 0.75): DMatchLite[] {
  if (desRef.rows === 0 || desI.rows === 0) return [];
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const knnMatches = new cv.DMatchVectorVector();
  bf.knnMatch(desRef, desI, knnMatches, 2);
  const good: DMatchLite[] = [];
  for (let i = 0; i < knnMatches.size(); i++) {
    const pair = knnMatches.get(i);
    if (pair.size() !== 2) continue;
    const m = pair.get(0);
    const n = pair.get(1);
    if (m.distance < ratio * n.distance) {
      good.push({ queryIdx: m.queryIdx, trainIdx: m.trainIdx, distance: m.distance });
    }
  }
  knnMatches.delete();
  bf.delete();
  return good;
}

export function estimateHomography(
  cv: CV,
  kpRef: any,
  kpI: any,
  matches: DMatchLite[],
  ransacThresh = 4.0,
): { H: number[] | null; inliers: number } {
  if (matches.length < 4) return { H: null, inliers: 0 };

  const srcData = new Float32Array(matches.length * 2);
  const dstData = new Float32Array(matches.length * 2);
  matches.forEach((m, i) => {
    const ptI = kpI.get(m.trainIdx).pt;
    const ptRef = kpRef.get(m.queryIdx).pt;
    srcData[i * 2] = ptI.x;
    srcData[i * 2 + 1] = ptI.y;
    dstData[i * 2] = ptRef.x;
    dstData[i * 2 + 1] = ptRef.y;
  });

  const src = cv.matFromArray(matches.length, 1, cv.CV_32FC2, srcData);
  const dst = cv.matFromArray(matches.length, 1, cv.CV_32FC2, dstData);
  const mask = new cv.Mat();
  const H = cv.findHomography(src, dst, cv.RANSAC, ransacThresh, mask);
  src.delete();
  dst.delete();

  if (!H || H.empty()) {
    H?.delete();
    mask.delete();
    return { H: null, inliers: 0 };
  }

  let inliers = 0;
  for (let i = 0; i < mask.rows; i++) {
    if (mask.data[i]) inliers++;
  }
  const Hdata = Array.from(H.data64F as Float64Array);
  H.delete();
  mask.delete();
  return { H: Hdata, inliers };
}

function scaleMatrix(s: number): number[] {
  return [s, 0, 0, 0, s, 0, 0, 0, 1];
}

function invScaleMatrix(s: number): number[] {
  const inv = 1 / s;
  return [inv, 0, 0, 0, inv, 0, 0, 0, 1];
}

function matmul3(a: number[], b: number[]): number[] {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

/** Rescale a homography computed on downscaled images to full-resolution coordinates. */
export function rescaleHomography(Hscaled: number[], refScale: number, srcScale: number): number[] {
  return matmul3(matmul3(invScaleMatrix(refScale), Hscaled), scaleMatrix(srcScale));
}

export function warpAndMask(
  cv: CV,
  bgr: any,
  Hfull: number[],
  outW: number,
  outH: number,
): { warped: any; mask: any } {
  const H = cv.matFromArray(3, 3, cv.CV_64F, Hfull);
  const dsize = new cv.Size(outW, outH);

  const warped = new cv.Mat();
  cv.warpPerspective(bgr, warped, H, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));

  const srcMask = new cv.Mat(bgr.rows, bgr.cols, cv.CV_8UC1, new cv.Scalar(255, 0, 0, 0));
  const mask = new cv.Mat();
  cv.warpPerspective(srcMask, mask, H, dsize, cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  srcMask.delete();
  H.delete();

  return { warped, mask };
}

// --- largest axis-aligned rectangle inscribed in a 0/255 mask -------------

function largestRectInHistogram(heights: Int32Array): [number, number, number, number] {
  const stack: Array<[number, number]> = [];
  let bestArea = 0;
  let best: [number, number, number, number] = [0, 0, 0, 0];
  const n = heights.length;
  for (let i = 0; i <= n; i++) {
    const curH = i < n ? heights[i] : 0;
    let start = i;
    while (stack.length && stack[stack.length - 1][1] > curH) {
      const [idx, h] = stack.pop()!;
      const w = i - idx;
      const area = w * h;
      if (area > bestArea) {
        bestArea = area;
        best = [idx, w, h, area];
      }
      start = idx;
    }
    stack.push([start, curH]);
  }
  return best;
}

export function largestInscribedRectangle(cv: CV, mask: any, downscaleMaxSide = 1000, erodeIters = 2): Rect {
  const h0 = mask.rows;
  const w0 = mask.cols;
  let scale = Math.min(1, downscaleMaxSide / Math.max(h0, w0));

  let small: any;
  if (scale < 1) {
    const dsize = new cv.Size(Math.max(1, Math.round(w0 * scale)), Math.max(1, Math.round(h0 * scale)));
    small = new cv.Mat();
    cv.resize(mask, small, dsize, 0, 0, cv.INTER_NEAREST);
  } else {
    small = mask.clone();
    scale = 1;
  }

  const binary = new cv.Mat();
  cv.threshold(small, binary, 127, 1, cv.THRESH_BINARY);
  small.delete();

  let working = binary;
  if (erodeIters > 0) {
    // Deliberately no explicit borderType/borderValue here, same as align.py's
    // `cv2.erode(binary, kernel, iterations=erode_iters)` -- OpenCV's default
    // erosion border treats the outside as foreground, so it doesn't erode
    // the mask from the image edges inward the way BORDER_CONSTANT(0) would.
    const kernel = new cv.Mat(3, 3, cv.CV_8U, new cv.Scalar(1, 0, 0, 0));
    const eroded = new cv.Mat();
    cv.erode(binary, eroded, kernel, new cv.Point(-1, -1), erodeIters);
    kernel.delete();
    binary.delete();
    working = eroded;
  }

  const rows = working.rows;
  const cols = working.cols;
  const data: Uint8Array = working.data;
  const heights = new Int32Array(cols);
  let bestArea = 0;
  let best = [0, 0, 0, 0];

  for (let y = 0; y < rows; y++) {
    const rowOffset = y * cols;
    for (let x = 0; x < cols; x++) {
      heights[x] = data[rowOffset + x] > 0 ? heights[x] + 1 : 0;
    }
    const [bx, bw, bh, area] = largestRectInHistogram(heights);
    if (area > bestArea) {
      bestArea = area;
      best = [bx, y - bh + 1, bw, bh];
    }
  }
  working.delete();

  const [bx, by, bw, bh] = best;
  if (bw <= 0 || bh <= 0) {
    return { x: 0, y: 0, w: w0, h: h0 };
  }

  const invScale = 1 / scale;
  const margin = Math.max(1, Math.ceil(invScale));

  let xFull = Math.ceil(bx * invScale) + margin;
  let yFull = Math.ceil(by * invScale) + margin;
  let wFull = Math.floor(bw * invScale) - 2 * margin;
  let hFull = Math.floor(bh * invScale) - 2 * margin;

  xFull = Math.max(0, Math.min(xFull, w0 - 1));
  yFull = Math.max(0, Math.min(yFull, h0 - 1));
  wFull = Math.max(1, Math.min(wFull, w0 - xFull));
  hFull = Math.max(1, Math.min(hFull, h0 - yFull));

  return { x: xFull, y: yFull, w: wFull, h: hFull };
}

export function cropMat(cv: CV, mat: any, rect: Rect): any {
  const roi = mat.roi(new cv.Rect(rect.x, rect.y, rect.w, rect.h));
  const cropped = roi.clone();
  roi.delete();
  return cropped;
}
