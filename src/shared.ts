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

export const STAGE_LABELS: Record<StageKey, string> = {
  align: "位置合わせ中",
  background: "背景を生成中",
  detect: "被写体を検出中",
  composite_all: "合成画像を生成中(全フレーム重ね合わせ)",
  finalize: "仕上げ中",
};

export type FrameStatus = "reference" | "ok" | "failed";

export interface AlignedFrameResult {
  filename: string;
  status: FrameStatus;
  inliers: number | null;
  reason: string | null;
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
  warnings: string[];
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
