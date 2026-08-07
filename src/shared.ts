// Types shared between the main thread (UI) and the pipeline worker. Kept
// free of DOM- and WebWorker-specific lib types so it can be included by
// both tsconfig.app.json and tsconfig.worker.json.

export interface PipelineOptions {
  referenceIndex: number;
  minInliers: number;
  outputAligned: boolean;
  outputMerged: boolean;
  outputCompositeAll: boolean;
  feather: number;
  forceOpaque: boolean;
  overlapPriority: "first" | "last";
  maxSubjectArea: number;
  decontaminate: boolean;
  edgeNoiseFloor: number;
  opacityThreshold: number;
  decontamMaxCorrection: number;
  confidentAlphaThreshold: number;
  overlapBlendSigmaPx: number;
}

export const DEFAULT_OPTIONS: PipelineOptions = {
  referenceIndex: 0,
  minInliers: 15,
  outputAligned: true,
  outputMerged: true,
  outputCompositeAll: true,
  feather: 0,
  forceOpaque: true,
  overlapPriority: "first",
  maxSubjectArea: 0.15,
  decontaminate: true,
  edgeNoiseFloor: 0.08,
  opacityThreshold: 0.15,
  decontamMaxCorrection: 60,
  confidentAlphaThreshold: 0.5,
  overlapBlendSigmaPx: 18,
};

export type StageKey = "align" | "background" | "detect" | "composite_all" | "finalize";

/** i18n.ts keys for each stage's progress label -- kept here (not the label text itself) so
 * this file stays language-free; only the main thread (which has the current Lang) calls
 * `t(lang, STAGE_KEYS[stage])`. */
export const STAGE_KEYS: Record<StageKey, string> = {
  align: "stageAlign",
  background: "stageBackground",
  detect: "stageDetect",
  composite_all: "stageCompositeAll",
  finalize: "stageFinalize",
};

/** A translatable message: an i18n.ts dictionary key plus the values to interpolate into it.
 * Used for anything generated in the worker (reasons, warnings, thrown errors) instead of a
 * literal string, since the worker has no notion of the user's selected language -- only the
 * main thread does, and it calls `t(lang, code, params)` at render time. */
export interface I18nMessage {
  code: string;
  params?: Record<string, string | number>;
}

/** Thrown from worker-side code (pipeline.ts, matte.ts, cvRuntime.ts) instead of a plain
 * `Error` with baked-in Japanese/English text, so the failure reason survives as data
 * (`code`/`params`) all the way to the main thread's `describeError`-equivalent handling,
 * which can translate it into whichever language is currently selected. */
export class AppError extends Error {
  code: string;
  params?: Record<string, string | number>;
  constructor(code: string, params?: Record<string, string | number>) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.params = params;
  }
}

export type FrameStatus = "reference" | "ok" | "failed";

export interface AlignedFrameResult {
  filename: string;
  status: FrameStatus;
  inliers: number | null;
  reason: I18nMessage | null;
  outputName: string | null;
  blob: Blob | null;
  thumbBlob: Blob | null;
}

export interface ImageOutput {
  outputName: string;
  blob: Blob;
  thumbBlob: Blob;
}

export interface CompositeAllOutput extends ImageOutput {
  frameCount: number;
}

export interface PipelineResult {
  referenceFilename: string;
  cropRect: { x: number; y: number; w: number; h: number };
  aligned: AlignedFrameResult[];
  merged: ImageOutput | null;
  compositeAll: CompositeAllOutput | null;
  warnings: I18nMessage[];
  zipBlob: Blob | null;
}

// --- postMessage protocol -------------------------------------------------

export interface InputFile {
  name: string;
  bitmap: ImageBitmap;
}

export interface RunMessage {
  type: "run";
  files: InputFile[];
  options: PipelineOptions;
}

export type WorkerRequest = RunMessage;

export interface ProgressMessage {
  type: "progress";
  stage: StageKey;
  current: number;
  total: number;
  percent: number;
}

export interface ResultMessage {
  type: "result";
  result: PipelineResult;
}

export interface ErrorMessage {
  type: "error";
  /** i18n code for known application-level failures (AppError); absent for raw/unexpected
   * errors (a decoded OpenCV C++ exception, a generic JS error), which can't be pre-translated
   * since their text comes from the browser/library itself. */
  code?: string;
  params?: Record<string, string | number>;
  /** Always present: the translated (if `code` was set) or raw fallback message, for callers
   * that don't have -- or don't want to depend on -- the i18n dictionary. */
  message: string;
}

/** Reported once, the first time a job needs the subject-cutout model and it isn't cached in
 * this worker yet -- shown as auxiliary status text, not folded into the main stage progress
 * bar (its size isn't known ahead of the weighted stage-unit plan). */
export interface ModelProgressMessage {
  type: "model-progress";
  loadedBytes: number;
  totalBytes: number | null;
}

export type WorkerResponse = ProgressMessage | ResultMessage | ErrorMessage | ModelProgressMessage;

// --- ingest safety limits (client-side equivalents of the server's) ------

export const MAX_FILES = 8;
export const MIN_FILES = 2;
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
// Hard reject above this (decompression-bomb guard); anything between this and
// MAX_PROCESSING_PIXELS is downscaled instead of rejected, see decodeUploadedFile.
export const MAX_TOTAL_PIXELS = 150_000_000;
// The full pipeline holds roughly one working-resolution copy of every uploaded frame
// simultaneously (for median-stack background generation, which is inherent to the
// algorithm -- not something this port can avoid without changing its behavior). That
// competes for OpenCV.js's WASM heap, which has a much lower ceiling than the browser
// tab's regular memory -- multi-frame bursts above ~20MP/frame were observed to exhaust
// it. Anything larger is downscaled to this many pixels (aspect ratio preserved) on
// ingest, trading maximum output resolution for reliability.
export const MAX_PROCESSING_PIXELS = 20_000_000;
