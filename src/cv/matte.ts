/// <reference types="vite/client" />
// onnxruntime-web replacement for rembg's U2netpSession (rembg/sessions/u2netp.py):
// same pre/post-processing (LANCZOS resize, per-image-max normalization + ImageNet
// mean/std, min-max output normalization, LANCZOS resize back to source resolution),
// run against the exact same u2netp.onnx rembg itself downloads (MD5
// 8e83ca70e441ab06c318d82300c84806, from
// https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx).
//
// That canonical URL doesn't send CORS headers (its Azure Blob backend serves the
// asset with none), so it can't be fetched cross-origin from a GitHub Pages site --
// the model is bundled in this repo under public/models/u2netp.onnx instead and
// served same-origin.
import type { CV } from "./cvRuntime";

const MODEL_URL = `${import.meta.env.BASE_URL}models/u2netp.onnx`;
const INPUT_SIZE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let ortModule: any = null;
let sessionPromise: Promise<any> | null = null;

export async function loadOrt(): Promise<any> {
  if (!ortModule) {
    // The "/wasm" subpath sticks to the plain CPU backend only -- the default
    // "onnxruntime-web" entry point's bundle also references the WebGPU/JSEP
    // backend (a separate ~27MB wasm binary), which Vite then ships as a build
    // asset even though it's never selected at runtime (only "wasm" is used,
    // see the executionProviders below).
    const mod = await import("onnxruntime-web/wasm");
    mod.env.wasm.numThreads = 1;
    // GitHub Pages can't set COOP/COEP, so SharedArrayBuffer/thread pool aren't
    // available -- numThreads=1 keeps ORT on the single-thread wasm path instead
    // of trying (and failing) to spin up worker threads.
    mod.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
    ortModule = mod;
  }
  return ortModule;
}

export type MatteProgress = (loadedBytes: number, totalBytes: number | null) => void;

export async function loadMatteSession(onProgress?: MatteProgress): Promise<any> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await loadOrt();
      const modelBytes = await fetchWithProgress(MODEL_URL, onProgress);
      return ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
    })();
  }
  return sessionPromise;
}

async function fetchWithProgress(url: string, onProgress?: MatteProgress): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`被写体切り抜きモデルの取得に失敗しました (HTTP ${res.status})`);
  }
  const total = Number(res.headers.get("content-length")) || null;
  const reader = res.body?.getReader();
  if (!reader) {
    return new Uint8Array(await res.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** High-quality subject alpha matte for one frame, via u2netp saliency segmentation.
 * Returns a CV_32FC1 Mat, same H x W as `frameBgr`, values in [0, 1]. */
export async function subjectAlphaMatte(cv: CV, ort: any, session: any, frameBgr: any): Promise<any> {
  const origW = frameBgr.cols;
  const origH = frameBgr.rows;

  // Resize (LANCZOS, matching PIL's `Image.resize(..., Image.Resampling.LANCZOS)`)
  // before the BGR->RGB channel swap -- a pure permutation that commutes with
  // resampling, so doing it after keeps the (expensive) resize on fewer bytes
  // without changing the numeric result.
  const small = new cv.Mat();
  cv.resize(frameBgr, small, new cv.Size(INPUT_SIZE, INPUT_SIZE), 0, 0, cv.INTER_LANCZOS4);
  const smallRgb = new cv.Mat();
  cv.cvtColor(small, smallRgb, cv.COLOR_BGR2RGB);
  small.delete();

  const rgbData: Uint8Array = smallRgb.data;
  const plane = INPUT_SIZE * INPUT_SIZE;

  // rembg normalizes by the resized image's own max byte value, not a fixed 255.
  let maxVal = 0;
  for (let i = 0; i < rgbData.length; i++) {
    if (rgbData[i] > maxVal) maxVal = rgbData[i];
  }
  const denom = Math.max(maxVal, 1e-6);

  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const o = i * 3;
    chw[i] = (rgbData[o] / denom - MEAN[0]) / STD[0];
    chw[plane + i] = (rgbData[o + 1] / denom - MEAN[1]) / STD[1];
    chw[plane * 2 + i] = (rgbData[o + 2] / denom - MEAN[2]) / STD[2];
  }
  smallRgb.delete();

  const inputTensor = new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const feeds: Record<string, any> = {};
  feeds[session.inputNames[0]] = inputTensor;
  const results = await session.run(feeds);
  const outputTensor = results[session.outputNames[0]];

  const dims: number[] = outputTensor.dims;
  const outH = dims[dims.length - 2];
  const outW = dims[dims.length - 1];
  const outPlane = outH * outW;
  // Batch is always 1 here, so channel 0's H*W block is always the leading
  // `outPlane` floats of the flat NCHW buffer regardless of channel count --
  // matches rembg's `ort_outs[0][:, 0, :, :]`.
  const pred = outputTensor.data as Float32Array;

  let mi = Infinity;
  let ma = -Infinity;
  for (let i = 0; i < outPlane; i++) {
    const v = pred[i];
    if (v < mi) mi = v;
    if (v > ma) ma = v;
  }
  const range = ma - mi;

  const small8 = new cv.Mat(outH, outW, cv.CV_8UC1);
  const small8Data: Uint8Array = small8.data;
  for (let i = 0; i < outPlane; i++) {
    let norm = range === 0 ? 0 : (pred[i] - mi) / range;
    norm = norm < 0 ? 0 : norm > 1 ? 1 : norm;
    small8Data[i] = Math.trunc(norm * 255); // truncates, matching `.astype("uint8")`
  }

  const fullU8 = new cv.Mat();
  cv.resize(small8, fullU8, new cv.Size(origW, origH), 0, 0, cv.INTER_LANCZOS4);
  small8.delete();

  const alpha = new cv.Mat();
  fullU8.convertTo(alpha, cv.CV_32FC1, 1 / 255, 0);
  fullU8.delete();

  return alpha;
}
