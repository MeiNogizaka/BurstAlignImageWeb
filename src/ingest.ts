// Main-thread file validation + decode. No OpenCV dependency here -- this
// only needs browser-native File/ImageBitmap APIs, so it stays out of the
// worker and its result (an ImageBitmap) is handed to the worker via a
// transferable postMessage.
import { MAX_FILE_BYTES, MAX_LONG_EDGE_PX, MAX_TOTAL_PIXELS } from "./shared";

export class IngestError extends Error {}

const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);

function looksLikeImage(file: File): boolean {
  if (ALLOWED_TYPES.has(file.type)) return true;
  return /\.(jpe?g|png)$/i.test(file.name);
}

/**
 * Validate + decode one uploaded file into an EXIF-corrected, size-bounded ImageBitmap.
 *
 * There is no browser API to probe just an image's header dimensions without decoding
 * it (unlike Pillow's lazy `Image.open()`), so the decompression-bomb guard below can't
 * run before decode the way the original server-side check did -- a maliciously huge
 * image is fully decoded before this rejects it. Acceptable for a single-user client-side
 * tool processing the user's own photos.
 */
export async function decodeUploadedFile(file: File): Promise<ImageBitmap> {
  if (!looksLikeImage(file)) {
    throw new IngestError(`未対応のファイル形式です: ${file.name}`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new IngestError(`ファイルサイズが大きすぎます: ${file.name}`);
  }

  let probe: ImageBitmap;
  try {
    probe = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new IngestError(`画像として読み込めませんでした: ${file.name}`);
  }

  const { width, height } = probe;
  if (width * height > MAX_TOTAL_PIXELS) {
    probe.close();
    throw new IngestError(`画像の解像度が大きすぎます: ${file.name} (${width}x${height})`);
  }

  if (Math.max(width, height) <= MAX_LONG_EDGE_PX) {
    return probe;
  }

  const scale = MAX_LONG_EDGE_PX / Math.max(width, height);
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));
  probe.close();
  try {
    return await createImageBitmap(file, {
      imageOrientation: "from-image",
      resizeWidth: targetW,
      resizeHeight: targetH,
      resizeQuality: "high",
    });
  } catch {
    throw new IngestError(`画像として読み込めませんでした: ${file.name}`);
  }
}
