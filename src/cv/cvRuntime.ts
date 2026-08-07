/// <reference types="vite/client" />
// Loads OpenCV.js and hands back the ready module.
//
// This deliberately does NOT `import` the @techstark/opencv-js npm package.
// Bundling that ~10MB emscripten UMD file through Vite's CJS interop and then
// loading the result via dynamic import() inside a module Worker was observed
// to hang indefinitely (the import's module-evaluation promise never settles)
// -- even though the exact same unmodified file initializes in under a second
// via a plain <script> tag, importScripts(), or fetch+eval. The vite.config.ts
// static-copy plugin instead ships the untouched file at `${BASE_URL}opencv.js`,
// and this loads it the way that's proven to work.
//
// Executed via `new Function(code)()` (a sloppy-mode top-level function call,
// so `this`/implicit globals resolve to the worker's `self`) rather than
// importScripts(), since importScripts() throws when called from a module
// Worker (which this app's pipeline worker is, in order to dynamically import
// onnxruntime-web and its own pipeline modules).
//
// The object the factory assigns to `self.cv` is thenable but resolves TO
// ITSELF (`cv.then(v => v === cv)` is true) -- it's a hybrid promise/module
// object, not a disposable wrapper around one. Native Promise resolution,
// on seeing a "thenable" value used to resolve another promise, always tries
// to recursively adopt its state by calling `.then()` on it again -- and
// this object's `.then` only supports a single subscriber (its callback
// queue is already drained after the first resolution), so that second call
// never fires either callback. The net effect: resolving *any* real Promise
// with this value -- including via plain `await candidate`, which performs
// the exact same internal resolution algorithm -- hangs forever with no
// error, no matter how many legitimate Promise layers wrap it. Verified in
// isolation, not just in this app.
//
// The fix is to delete the lingering `.then` off the resolved object before
// it ever touches a real Promise's resolve() -- once that's gone, native
// Promise/await machinery treats it as an ordinary object and resolves
// immediately.
import { AppError } from "../shared";

export type CV = any;

const MODEL_SCRIPT_URL = `${import.meta.env.BASE_URL}opencv.js`;

let cvPromise: Promise<CV> | null = null;

export function loadCv(): Promise<CV> {
  if (!cvPromise) {
    cvPromise = fetch(MODEL_SCRIPT_URL)
      .then((res) => {
        if (!res.ok) {
          throw new AppError("openCvLoadFailed", { status: res.status });
        }
        return res.text();
      })
      .then((code) => {
        new Function(code)();

        const candidate: any = (self as any).cv;
        if (candidate && typeof candidate.then === "function") {
          return new Promise<CV>((resolve, reject) => {
            candidate.then(
              (cv: CV) => resolve(disarm(cv)),
              (err: unknown) => reject(err),
            );
          });
        }
        if (candidate && (candidate.Mat || candidate.calledRun)) {
          return candidate as CV;
        }
        return new Promise<CV>((resolve) => {
          candidate.onRuntimeInitialized = () => resolve(disarm(candidate));
        });
      });
  }
  return cvPromise;
}

function disarm(cv: CV): CV {
  if (cv && typeof cv.then === "function") {
    try {
      delete cv.then;
    } catch {
      // ignore -- non-configurable on some builds; resolving with it still
      // recurses in that case, but there's no further fallback available
    }
  }
  return cv;
}

/** Runs `fn`, deleting every cv.Mat/Vector handed to `track()` afterwards -- OpenCV.js
 * heap objects are not garbage collected, so this is the guard against leaking WASM
 * memory across a many-frame pipeline. */
export function withMats<T>(fn: (track: <M extends { delete(): void }>(m: M) => M) => T): T {
  const owned: { delete(): void }[] = [];
  const track = <M extends { delete(): void }>(m: M): M => {
    owned.push(m);
    return m;
  };
  try {
    return fn(track);
  } finally {
    for (const m of owned) {
      try {
        m.delete();
      } catch {
        // already deleted / not a real handle -- fine to ignore during cleanup
      }
    }
  }
}

export async function withMatsAsync<T>(
  fn: (track: <M extends { delete(): void }>(m: M) => M) => Promise<T>,
): Promise<T> {
  const owned: { delete(): void }[] = [];
  const track = <M extends { delete(): void }>(m: M): M => {
    owned.push(m);
    return m;
  };
  try {
    return await fn(track);
  } finally {
    for (const m of owned) {
      try {
        m.delete();
      } catch {
        // ignore
      }
    }
  }
}
