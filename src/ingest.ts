// Main-thread file validation + decode. No OpenCV dependency here -- this
// only needs browser-native File/ImageBitmap APIs, so it stays out of the
// worker and its result (an ImageBitmap) is handed to the worker via a
// transferable postMessage.
import { MAX_FILE_BYTES, MAX_PROCESSING_PIXELS, MAX_TOTAL_PIXELS } from "./shared";

/** Carries an i18n.ts code + params instead of a baked-in-language message, same rationale as
 * `AppError` (shared.ts) for the worker side -- this runs on the main thread, which does know
 * the current language, but keeping the same {code, params} shape lets callers translate at
 * render/re-render time (e.g. after a language switch) instead of only once at throw time. */
export class IngestError extends Error {
  code: string;
  params?: Record<string, string | number>;
  constructor(code: string, params?: Record<string, string | number>) {
    super(code);
    this.name = "IngestError";
    this.code = code;
    this.params = params;
  }
}

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
    throw new IngestError("ingestUnsupportedFormat", { filename: file.name });
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new IngestError("ingestFileTooLarge", { filename: file.name });
  }

  let probe: ImageBitmap;
  try {
    probe = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new IngestError("ingestDecodeFailed", { filename: file.name });
  }

  const { width, height } = probe;
  const totalPixels = width * height;
  if (totalPixels > MAX_TOTAL_PIXELS) {
    probe.close();
    throw new IngestError("ingestTooHighRes", { filename: file.name, width, height });
  }

  if (totalPixels <= MAX_PROCESSING_PIXELS) {
    return probe;
  }

  // Downscale to at most MAX_PROCESSING_PIXELS total pixels, aspect ratio preserved --
  // this is the memory-budget cap (see MAX_PROCESSING_PIXELS), not the bomb guard above.
  const scale = Math.sqrt(MAX_PROCESSING_PIXELS / totalPixels);
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
    throw new IngestError("ingestDecodeFailed", { filename: file.name });
  }
}
