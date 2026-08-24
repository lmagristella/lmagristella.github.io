// live-worker-threaded.js
// The threaded-mode counterpart to live-worker.js: ONE instance of this
// runs (not a pool of many), loading excalibur_scene_threaded.wasm -- a
// real Emscripten pthread build. live.js only creates this worker once
// window.crossOriginIsolated is true (see coi-serviceworker.js), which is
// required for SharedArrayBuffer/pthreads to work at all.
//
// The per-pixel loop itself is NOT parallelized via OpenMP (Emscripten's
// OpenMP runtime hangs indefinitely under WASM pthreads here -- confirmed
// empirically) but via a small raw std::thread work-stealing dispatcher
// (excalibur/scene/SceneTrace.hpp's detail::threaded_parallel_for),
// activated by setting `nthreads` > 1 in the spec sent to
// traceWeakFieldChunk/traceSchwarzschildChunk -- see toWeakFieldSpec/
// toSchwarzschildSpec below, and live.js's TRACE_NTHREADS.
//
// Message protocol identical to live-worker.js (see that file's header
// comment) -- only the module loaded and the extra `nthreads` spec field
// differ, so the two are kept as separate files rather than one
// parameterized script, matching the project's existing convention of
// small self-contained worker files.
importScripts('excalibur_scene_threaded.js');
const modulePromise = ExcaliburSceneThreaded();

let KIND_LOOKUP = null;
function kindEnum(M, intKind) {
  if (!KIND_LOOKUP) {
    KIND_LOOKUP = [M.LensKind.PointMass, M.LensKind.SIS, M.LensKind.NFW,
                   M.LensKind.TriaxialNFW, M.LensKind.HSWVoid, M.LensKind.GaussianSphere];
  }
  return KIND_LOOKUP[intKind];
}

function vecDouble(M, arr) {
  const v = new M.VectorDouble();
  for (const x of arr) v.push_back(x);
  return v;
}

function vecLensSpec(M, lenses) {
  const v = new M.VectorLensSpec();
  for (const l of lenses) {
    v.push_back({ kind: kindEnum(M, l.kind), x_mpc: l.x_mpc, y_mpc: l.y_mpc, z_mpc: l.z_mpc || 0,
                  params: vecDouble(M, l.params) });
  }
  return v;
}

function toWeakFieldSpec(M, spec) {
  return {
    lenses: vecLensSpec(M, spec.lenses), N: spec.N, half_fov_mpc: spec.half_fov_mpc,
    D_l_mpc: spec.D_l_mpc, D_ls_mpc: spec.D_ls_mpc, rtol: spec.rtol, atol: spec.atol,
    nthreads: spec.nthreads || 0,
  };
}
function toSchwarzschildSpec(spec) {
  return {
    bh_mass_1e6_msun: spec.bh_mass_1e6_msun, x_mpc: spec.x_mpc, y_mpc: spec.y_mpc, N: spec.N,
    half_fov_rs: spec.half_fov_rs, D_l_rs: spec.D_l_rs, D_ls_rs: spec.D_ls_rs, rtol: spec.rtol, atol: spec.atol,
    nthreads: spec.nthreads || 0,
  };
}

async function handleChunk(e) {
  const { id, mode, spec, rowStart, rowEnd } = e.data;
  const M = await modulePromise;
  const chunk = mode === 'weak_field'
    ? M.traceWeakFieldChunk(toWeakFieldSpec(M, spec), rowStart, rowEnd)
    : M.traceSchwarzschildChunk(toSchwarzschildSpec(spec), rowStart, rowEnd);
  self.postMessage({ id, status: 'chunk-done', idx_start: chunk.idx_start, idx_end: chunk.idx_end,
                     beta1: chunk.beta1, beta2: chunk.beta2, img_x: chunk.img_x, img_y: chunk.img_y });
}

async function handleFinalize(e) {
  const { id, mode, spec, beta1, beta2, img_x, img_y } = e.data;
  const M = await modulePromise;
  const result = mode === 'weak_field'
    ? M.finalizeWeakField(toWeakFieldSpec(M, spec), beta1, beta2, img_x, img_y)
    : M.finalizeSchwarzschild(toSchwarzschildSpec(spec), beta1, beta2, img_x, img_y);

  const outBeta1 = Float32Array.from(result.beta1);
  const outBeta2 = Float32Array.from(result.beta2);
  const overlays = {
    critical_tangential: result.critical_tangential,
    critical_radial: result.critical_radial,
    caustic_tangential: result.caustic_tangential,
    caustic_radial: result.caustic_radial,
  };
  self.postMessage(
    { id, status: 'done', N: result.N, half: result.half, unit_label: result.unit_label,
      beta1: outBeta1, beta2: outBeta2, overlays },
    [outBeta1.buffer, outBeta2.buffer]
  );
}

// addEventListener, NOT self.onmessage= -- this worker hosts the pthread-
// enabled module's PRIMARY instance (it spawns its own pool of pthread
// sub-workers internally), and Emscripten's pthread runtime needs to
// receive its own internal coordination messages on this same worker.
// Overwriting self.onmessage (single-slot assignment) instead of adding a
// listener silently swallowed those and hung every trace call indefinitely
// -- confirmed empirically: identical tracing code called directly (no
// self.onmessage in the way) returned in ~20ms, this exact handler body
// wired up via self.onmessage= never returned at all.
self.addEventListener('message', (e) => {
  const { id, kind } = e.data;
  const handler = kind === 'chunk' ? handleChunk : kind === 'finalize' ? handleFinalize : null;
  if (!handler) { self.postMessage({ id, status: 'error', message: `unknown kind '${kind}'` }); return; }
  handler(e).catch((err) => {
    self.postMessage({ id, status: 'error', message: err && err.message ? err.message : String(err) });
  });
});
