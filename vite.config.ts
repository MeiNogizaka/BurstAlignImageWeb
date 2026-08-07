import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// Project Pages URL is https://<user>.github.io/<repo>/ -- every asset
// reference (including the onnxruntime-web wasm path below) must go through
// this base, not a hardcoded "/".
const REPO_NAME = "BurstAlignImageWeb";

export default defineConfig({
  base: `/${REPO_NAME}/`,
  worker: {
    // The pipeline worker dynamically imports opencv-js/onnxruntime-web at
    // runtime (lazy-loaded only once processing starts); the default "iife"
    // worker format can't do that, so it must be "es".
    format: "es",
  },
  build: {
    target: "es2022",
    // opencv.js embeds its wasm as base64 and is ~10MB on its own; raise the
    // warning threshold instead of fighting a false-positive chunk-size warning.
    chunkSizeWarningLimit: 15000,
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          // onnxruntime-web fetches its wasm binary by URL at runtime rather
          // than through the module graph, so it can't be bundled normally --
          // copy the plain (non-threaded-pool, non-webgpu/jsep) wasm runtime
          // as a static asset and point ort.env.wasm.wasmPaths at it.
          src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
          dest: "ort",
        },
        {
          src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
          dest: "ort",
        },
        {
          // Served raw and loaded via fetch+eval (see cvRuntime.ts) instead of
          // `import("@techstark/opencv-js")`: bundling this ~10MB emscripten
          // UMD file through Vite's CJS interop, then loading the result inside
          // a module Worker, was observed to hang indefinitely (the dynamic
          // import's module-evaluation promise never settled) even though the
          // exact same unmodified file loads and initializes in under a second
          // via a classic <script> tag, importScripts(), or fetch+eval. Serving
          // it untouched sidesteps whatever in that transform/module-worker
          // combination breaks it.
          src: "node_modules/@techstark/opencv-js/dist/opencv.js",
          dest: ".",
        },
      ],
    }),
  ],
});
