// ImageBitmap <-> cv.Mat(BGR) <-> Blob conversions. All BGR to mirror
// align.py's `img_bgr` convention throughout, so the ported color-space
// logic (COLOR_BGR2Lab, COLOR_BGR2GRAY, ...) can be copied over unchanged.
import type { CV } from "./cvRuntime";

export function bitmapToMatBGR(cv: CV, bitmap: ImageBitmap): any {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const rgba = cv.matFromImageData(imageData);
  const bgr = new cv.Mat();
  cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
  rgba.delete();
  return bgr;
}

export function matBGRToImageData(cv: CV, bgr: any): ImageData {
  const rgba = new cv.Mat();
  cv.cvtColor(bgr, rgba, cv.COLOR_BGR2RGBA);
  // Copy out of the Mat's WASM-heap-backed buffer before `.delete()` frees it.
  const imageData = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  rgba.delete();
  return imageData;
}

export async function matBGRToJpegBlob(cv: CV, bgr: any, quality = 0.95): Promise<Blob> {
  const imageData = matBGRToImageData(cv, bgr);
  const canvas = new OffscreenCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: "image/jpeg", quality });
}

export function makeThumbnailMat(cv: CV, bgr: any, maxSide = 800): any {
  const h = bgr.rows;
  const w = bgr.cols;
  const scale = Math.min(1, maxSide / Math.max(h, w));
  if (scale >= 1) return bgr.clone();
  const dsize = new cv.Size(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const out = new cv.Mat();
  cv.resize(bgr, out, dsize, 0, 0, cv.INTER_AREA);
  return out;
}

export async function saveOutput(
  cv: CV,
  bgr: any,
): Promise<{ blob: Blob; thumbBlob: Blob }> {
  const blob = await matBGRToJpegBlob(cv, bgr, 0.95);
  const thumbMat = makeThumbnailMat(cv, bgr, 800);
  const thumbBlob = await matBGRToJpegBlob(cv, thumbMat, 0.85);
  thumbMat.delete();
  return { blob, thumbBlob };
}
