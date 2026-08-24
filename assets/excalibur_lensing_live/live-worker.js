// live-worker.js
// One instance of this script runs per pool worker (see live.js's WorkerPool)
// -- each loads its OWN independent copy of the EXCALIBUR WASM module. The
// main thread hands out small row-range CHUNKS one at a time (work-queue /
// work-stealing dispatch, not a fixed contiguous band per worker), so a
// worker that lands on cheap rows just gets handed more chunks while one
// stuck on an expensive (near-a-lens) chunk simply does fewer -- this keeps
// the pool's wall-clock time closer to (total work / worker count) than a
// static equal-ROW split would, since row cost is NOT uniform (rows crossing
// close to a lens center need the expensive fine-tolerance window, see
// SceneTrace.hpp's impact-parameter culling comment).
//
// This is deliberately NOT SharedArrayBuffer/pthreads-based WASM threading:
// that needs Cross-Origin-Opener/Embedder-Policy response headers, which
// GitHub Pages' static file serving cannot set. A pool of independent
// Workers, each with its own WASM instance and no shared memory, needs no
// special headers at all -- it's plain postMessage/structured-clone.
//
// Two message kinds:
//   {id, kind:'chunk', mode, spec, rowStart, rowEnd} -> traces pixel rows
//     [rowStart, rowEnd) in one call, then:
//     postMessage({id, status:'chunk-done', idx_start, idx_end, beta1, beta2, img_x, img_y})
//     -- beta1/beta2/img_x/img_y are RAW SI (metres), not display-unit-
//     converted; live.js assembles every chunk's slice into full N*N arrays
//     and sends them to ONE pool worker for the 'finalize' step below.
//   {id, kind:'finalize', mode, spec, beta1, beta2, img_x, img_y} -> runs
//     the (fast, no ray tracing) FD/critical-curve/caustic extraction on the
//     complete assembled grid:
//     postMessage({id, status:'done', N, half, unit_label, beta1, beta2, overlays})
// Both kinds report {id, status:'error', message} on failure.
importScripts('excalibur_scene.js');
const modulePromise = ExcaliburScene();

// live.js's LENS_TYPES uses plain integer `kind` values (0..5, matching
// excalibur/scene/SceneDescription.hpp's LensKind enum order) so the main
// thread never needs to touch the WASM module. embind's enum_<LensKind>
// bindings, though, are NOT plain numbers on the JS side (M.LensKind.NFW is
// an opaque wrapper object) -- passing a raw integer for a LensSpec.kind
// field does NOT throw, but silently constructs the WRONG lens (confirmed
// empirically: kind=2 as a raw int produced zero critical-curve segments for
// a scene that produces one with the proper M.LensKind.NFW value). This
// lookup is the fix: always index into the real embind enum constants.
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
    // embind's value_object requires every registered field to be present --
    // this build isn't pthread-enabled and never spawns threads on its own
    // (see excalibur/scene/SceneTrace.hpp's dispatch_parallel_for: 0 means
    // "use exec::DefaultCpuBackend", the pre-existing behavior), but the
    // field still has to be sent or WASM throws "Missing field: nthreads".
    nthreads: 0,
  };
}
function toSchwarzschildSpec(spec) {
  return {
    bh_mass_1e6_msun: spec.bh_mass_1e6_msun, x_mpc: spec.x_mpc, y_mpc: spec.y_mpc, N: spec.N,
    half_fov_rs: spec.half_fov_rs, D_l_rs: spec.D_l_rs, D_ls_rs: spec.D_ls_rs, rtol: spec.rtol, atol: spec.atol,
    nthreads: 0,
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

  // finalize*() (wasm/scene_bindings.cpp) builds every result field via
  // emscripten::val::array(), so result.beta1/critical_tangential/etc. are
  // already plain JS arrays/objects here.
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

self.onmessage = (e) => {
  const { id, kind } = e.data;
  const handler = kind === 'chunk' ? handleChunk : kind === 'finalize' ? handleFinalize : null;
  if (!handler) { self.postMessage({ id, status: 'error', message: `unknown kind '${kind}'` }); return; }
  handler(e).catch((err) => {
    self.postMessage({ id, status: 'error', message: err && err.message ? err.message : String(err) });
  });
};
