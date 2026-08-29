// live.js — EXCALIBUR live lensing composer main-thread logic.
//
// Rendering pipeline (MLUT, sersicOnBeta/sersicDirect, paintToCanvas, render,
// mpc2px/px2mpc, segs2path, markerSVG, fovBorder, drawOverlays, drag-to-move-
// source, resize handling) is copied near-verbatim from
// ../excalibur_lensing_webapp/index.html -- it already only consumes
// {beta1, beta2, overlays, N, half}, so the only real change is WHERE that
// data comes from: a debounced postMessage to live-worker.js (which runs the
// actual WASM ray trace) instead of fetch()-ing a precomputed asset triple.
// NOT copied: PROFILES / loadProfile / buildProfileButtons / cache -- those
// were specific to the fixed 8-profile precomputed gallery and have no
// equivalent here (see buildLensList()/composeScene() below instead).

// Phones: a coarse pointer drives both the touch affordances and the compute
// budget below (pool size, target grid), since these are the same devices with
// the least CPU and the tightest memory ceiling.
const COARSE = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
const MOBILE_LAYOUT = () => window.matchMedia('(max-width:900px)').matches;

// index.html loads this file as live.js?v=N. Reuse that stamp for everything
// this file pulls in, so one deploy's markup can never end up driving another
// deploy's script or workers: GitHub Pages serves all of these with the same
// max-age, and a phone that had the page open before a deploy will happily
// pair fresh HTML with a cached live.js. That is exactly what left the mobile
// bottom-sheet button inert -- new markup with the button, old script with no
// listener for it, and no error anywhere to show for it.
const ASSET_V = (() => {
  try { return new URL(document.currentScript.src).search || ''; } catch (e) { return ''; }
})();

// LensKind values MUST match excalibur-cpp/include/excalibur/scene/SceneDescription.hpp's enum exactly.
const LENS_TYPES = [
  { kind: 0, name: 'PointMass', label: 'Point mass',
    params: [{ key: 'mass', label: 'Mass', unit: '×10¹² M☉', min: 1, max: 5000, step: 1, def: 500 }] },
  { kind: 1, name: 'SIS', label: 'SIS (isothermal sphere)',
    params: [{ key: 'sigma', label: 'σ', unit: 'km/s', min: 100, max: 400, step: 5, def: 220 }] },
  { kind: 2, name: 'NFW', label: 'NFW halo',
    params: [
      { key: 'M200', label: 'M₂₀₀', unit: '×10¹⁵ M☉', min: 0.1, max: 20, step: 0.1, def: 10 },
      { key: 'c', label: 'concentration', unit: '', min: 2, max: 15, step: 0.5, def: 6 },
    ] },
  { kind: 3, name: 'TriaxialNFW', label: 'Triaxial NFW',
    params: [
      { key: 'M200', label: 'M₂₀₀', unit: '×10¹⁵ M☉', min: 0.1, max: 20, step: 0.1, def: 6 },
      { key: 'c', label: 'concentration', unit: '', min: 2, max: 15, step: 0.5, def: 6 },
      { key: 'q2', label: 'q₂ (b/a)', unit: '', min: 0.3, max: 1, step: 0.05, def: 0.7 },
      { key: 'q3', label: 'q₃ (c/a)', unit: '', min: 0.3, max: 1, step: 0.05, def: 0.5 },
    ] },
  { kind: 4, name: 'HSWVoid', label: 'Cosmic void',
    params: [
      { key: 'delta_c', label: 'δ_c', unit: '', min: -1, max: -0.1, step: 0.05, def: -0.8 },
      { key: 'r_v', label: 'r_v', unit: 'Mpc', min: 0.2, max: 2, step: 0.05, def: 0.8 },
      { key: 'r0', label: 'r₀', unit: 'Mpc', min: 0.1, max: 1, step: 0.05, def: 0.4 },
      { key: 'boost', label: 'density boost', unit: '×', min: 1, max: 20000, step: 100, def: 12000 },
    ] },
  { kind: 5, name: 'GaussianSphere', label: 'Gaussian sphere',
    params: [
      { key: 'rho0', label: 'ρ₀', unit: 'M☉/Mpc³', min: 1e13, max: 1e16, step: 1e13, def: 5e14 },
      { key: 'sigma', label: 'σ', unit: 'Mpc', min: 0.1, max: 1, step: 0.05, def: 0.3 },
    ] },
];
const lensTypeByKind = (k) => LENS_TYPES.find(t => t.kind === k);

// Fixed (not user-adjustable in v1) scene geometry -- see the composer's
// info panel for why: this is deliberately simplified flat, non-cosmological
// weak-field lensing, distinct from the precomputed gallery's cosmological
// PerturbedFLRW pipeline at z_lens=1/z_source=2.
// Lensing efficiency goes as D_l*D_ls/D_s, and Sigma_crit as D_s/(D_l*D_ls).
// At the original 300/300 Mpc the default NFW halo sat BELOW critical density:
// no critical curve, no Einstein ring, just a faint magnification -- which
// contradicted the default scene's stated intent. Even both lens sliders at
// maximum only reached a ring 8% of the half-field wide. At 1500/1500 the
// default halo gives R_E = 0.52 Mpc (17% of the half-field) and the sliders
// still have room above that.
const WEAK_D_L_MPC = 1500, WEAK_D_LS_MPC = 1500, WEAK_HALF_FOV_MPC = 3.0;
// r_s scales with M, so a frame specified in r_s is scale-free: with the field
// of view and both distances given in r_s, the dimensionless problem has no
// free mass parameter left and the mass slider could not change the picture at
// all (measured: the beta/r_s map moved by 4.9e-7 r_s across a 12.5x mass
// change, pure integrator noise).
//
// Pin the frame to a FIXED PHYSICAL size instead, written as the r_s-frame of
// one reference mass. The field of view and the distances then shrink in r_s
// units as the mass grows, so a heavier hole genuinely fills more of the same
// physical window -- measured, the shadow goes from 2.5% of the half-field at
// 1e6 Msun to 24.9% at 8e6, while its absolute radius stays at the ~2.6 r_s
// physics demands. Calibrated at BH_REF_MASS so the default view is unchanged.
const BH_REF_MASS = 4.0;   // 1e6 Msun -- the mass the frame below is written for
const BH_REF_HALF_FOV_RS = 20.0, BH_REF_D_L_RS = 60, BH_REF_D_LS_RS = 60;
const bhFrameScale = () => BH_REF_MASS / bh.mass;
const bhHalfFovRs = () => BH_REF_HALF_FOV_RS * bhFrameScale();
const bhDlRs = () => BH_REF_D_L_RS * bhFrameScale();
const bhDlsRs = () => BH_REF_D_LS_RS * bhFrameScale();

// Top of the progressive resolution ladder -- the final, sharpest rung, and
// the same for every scene. This used to be a per-scene cost budget that
// CAPPED the target (down to 100, and 0.625x of that on a phone), so an
// expensive or mobile scene simply stopped climbing and sat at something like
// 88x88 forever. Giving cheap feedback fast is the ladder's job, not a
// ceiling's: the low rungs already put an image on screen almost immediately,
// so an expensive scene should take longer to reach the top, not be denied it.
// Cost is therefore paid in TIME now, not in final resolution.
const RESOLUTION_MAX = 700;

let nextLensId = 1;
let lensList = [{ id: nextLensId++, kind: 2, x_mpc: 0, y_mpc: 0, z_mpc: 0,
                  params: { M200: 10, c: 6 } }];  // default: single centered NFW -> Einstein ring
let metricMode = 'weak_field';
let bh = { mass: 4.0, x: 0, y: 0 };

let SCENE = { N: 0, half: WEAK_HALF_FOV_MPC, unit_label: 'Mpc', beta1: null, beta2: null, overlays: {} };
let dragging = false, rafId = null;
// D_ls_mpc: the PRIMARY source's own distance from the lens plane, separate
// from WEAK_D_LS_MPC (the fixed distance the WASM trace itself is computed
// at, i.e. the REFERENCE deflection field). Sources at any OTHER distance
// (this one, or each background-field member's own) reuse that single
// traced field via a closed-form rescale instead of a new trace -- see
// rescaleBeta() below for the formula and its validation.
const P = { cx: 0, cy: 0, Re: 0.1, ns: 1.0, ellip: 0.3, pa: 30, I0: 1.0, D_ls_mpc: WEAK_D_LS_MPC,
           showCritTan: true, showCritRad: false,
           showCaustTan: false, showCaustRad: false, showMark: true };

// Background field: a scatter of additional Sersic sources ("stars/
// galaxies"), each with its own distance, composited on top of the primary
// source. Off by default -- everything below only runs when explicitly
// enabled, so a scene with no field configured renders identically to
// before this existed.
let fieldEnabled = false;
let fieldSources = [];  // [{cx, cy, Re, ns, ellip, pa, brightness, D_ls_mpc}, ...]
const FIELD = { count: 24, dMin: 600, dMax: 4500 };

function generateField(count, dMin, dMax) {
  const lim = sourcePosLimit() * 0.9;  // margin so field members stay visibly inside the FOV
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      cx: (Math.random() * 2 - 1) * lim,
      cy: (Math.random() * 2 - 1) * lim,
      Re: 0.015 + Math.random() * 0.05,
      ns: 0.5 + Math.random() * 3.0,
      ellip: Math.random() * 0.6,
      pa: Math.random() * 180,
      brightness: 0.15 + Math.random() * 0.7,
      D_ls_mpc: dMin + Math.random() * Math.max(0, dMax - dMin),
    });
  }
  return out;
}

const csrc = document.getElementById('csrc');
const cimg = document.getElementById('cimg');
const ctxS = csrc.getContext('2d');
const ctxI = cimg.getContext('2d');
let DPR = 1;
let SZ_src = 1, offS_x = 0, offS_y = 0;
let SZ_img = 1, offI_x = 0, offI_y = 0;

function setupSize() {
  DPR = Math.min(window.devicePixelRatio || 1, 3);
  const wS = document.getElementById('wrap-src').getBoundingClientRect();
  const wI = document.getElementById('wrap-img').getBoundingClientRect();
  csrc.width = Math.round(wS.width * DPR); csrc.height = Math.round(wS.height * DPR);
  cimg.width = Math.round(wI.width * DPR); cimg.height = Math.round(wI.height * DPR);
  SZ_src = Math.min(csrc.width, csrc.height);
  SZ_img = Math.min(cimg.width, cimg.height);
  offS_x = (csrc.width - SZ_src) / 2; offS_y = (csrc.height - SZ_src) / 2;
  offI_x = (cimg.width - SZ_img) / 2; offI_y = (cimg.height - SZ_img) / 2;
  document.getElementById('svg-src').setAttribute('viewBox', `0 0 ${Math.round(wS.width)} ${Math.round(wS.height)}`);
  document.getElementById('svg-img').setAttribute('viewBox', `0 0 ${Math.round(wI.width)} ${Math.round(wI.height)}`);
}

const MLUT = (() => {
  const stops = [[0,0,4],[3,0,6],[8,1,14],[15,1,23],[23,2,33],[32,3,43],[41,4,54],
    [51,6,64],[61,9,74],[71,12,83],[81,16,91],[91,20,99],[101,25,107],[111,31,113],
    [120,37,119],[130,42,124],[139,48,128],[149,54,132],[158,59,135],[167,65,137],
    [176,71,139],[185,77,140],[194,82,141],[203,88,141],[211,94,141],[220,100,141],
    [228,106,140],[235,112,139],[242,118,138],[248,124,137],[253,131,136],[255,137,136],
    [255,144,136],[255,150,137],[255,157,139],[255,164,141],[255,170,144],[255,177,148],
    [255,183,153],[255,189,158],[255,196,164],[255,202,170],[255,208,178],[255,214,185],
    [253,220,194],[252,225,204],[252,231,213],[253,237,224],[254,243,235],[252,253,245]];
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (stops.length - 1), lo = Math.floor(t), hi = Math.min(lo + 1, stops.length - 1), f = t - lo;
    lut[i*4] = stops[lo][0] + f * (stops[hi][0] - stops[lo][0]);
    lut[i*4+1] = stops[lo][1] + f * (stops[hi][1] - stops[lo][1]);
    lut[i*4+2] = stops[lo][2] + f * (stops[hi][2] - stops[lo][2]);
    lut[i*4+3] = 255;
  }
  return lut;
})();

function bn(n) { return 2*n - 1/3 + 4/(405*n) + 46/(25515*n*n); }

// Closed-form rescale of the ONE traced reference deflection field (beta at
// world-x = WEAK_D_LS_MPC) to what beta WOULD be at a different source
// distance D_ls', without a new WASM trace: for a fixed lens configuration,
// the weak-field/small-deflection reduced deflection angle alpha_hat(impact
// parameter) does NOT depend on the source's own distance -- only the FINAL
// transverse shift (alpha_hat * remaining-path-length-FROM-THE-LENS-to-the-
// source) does.
//
// The camera is PERSPECTIVE (see excalibur-cpp's SceneTrace.hpp). This
// formula went through TWO iterations: the first (raw-position extrapolation
// to each source's own world-x) was internally self-consistent and passed
// re-trace validation, but was WRONG in a way that validation didn't catch --
// it compared rescaled output only against other raw traced positions, never
// against what the UI actually displays. The bug: a ray's raw physical
// position at world-x=Xr diverges from its image-plane grid coordinate
// (img_x, extrapolated to x=0) purely from perspective, EVEN WITH ZERO
// deflection -- at this composer's fixed D_l=Xr=300, an undeflected ray's
// raw beta is 2x its img_x, confirmed both analytically and by direct trace
// (a weak-lens corner pixel: img_x=-2.9375, raw beta=-5.8745, ratio
// 1.999834). Since the source position sliders (cx/cy) and the display
// window both live on the img_x/half scale, using raw beta directly (as the
// first iteration did) put every rendered image at roughly 2x the position/
// scale the source-plane panel and the position sliders agreed on --
// visually a real, visible mismatch between the two panels, not a rounding
// error. THIS is the bug that needed catching by actually comparing what's
// on screen, not by re-deriving the same formula and checking it against
// itself.
//
// Fixed by working in ANGLES (the standard convention: beta = theta -
// alpha_hat(theta)*D_ls/D_s, both beta and theta angular), then converting
// to a displayed length via the SAME fixed scale (D_l) img_x already uses --
// this is what forces beta and theta onto one shared, consistent scale by
// construction, for any lens depth and any source distance:
//   D_s_ref      = D_l + Xr                    (fixed: observer to reference source)
//   K            = D_l / D_s_ref                (fixed scale-correction constant)
//   D_ls_ref_eff = Xr - z0                       (actual reference lens->source distance)
//   D_s_tgt      = D_l + z0 + D_ls'              (observer to actual target source)
//   ratio2       = (D_s_ref/D_ls_ref_eff) * (D_ls'/D_s_tgt)
//   beta         = img_x*(1-ratio2) + ratio2*K*beta_ref
// Sanity check baked into the derivation itself: for an UNDEFLECTED ray
// (beta_ref = img_x*(Xr+D_l)/D_l exactly, no lens involved), this reduces to
// beta = img_x for ANY z0/D_ls' -- an unlensed ray must show the source at
// its true position, which is exactly what forced K's definition. Validated
// against real re-traces (each side's raw output K-corrected to its own
// D_s_tgt before comparing, so the check itself can't hide the same bug):
// across the same (z0, D_ls') grid as before (z0 -120 to +150 Mpc, D_ls' 30
// to 1200 Mpc), worst case 0.0001 pixel-widths.

// Composites the primary source (P, distance P.D_ls_mpc) plus every enabled
// background-field member (each its own distance) onto the LENSED image
// plane -- each source's own beta is the reference trace rescaled per the
// formula above, not a separate WASM call. Brightness is additive
// (independent light sources, physically the right way to combine them);
// P's own brightness weight is 1 here since the *global* I0 slider already
// scales the whole composited image in paintToCanvas() below -- field
// members carry their own random relative `brightness` instead, so the
// field reads as a scatter of differently-luminous background objects.
// The Schwarzschild trace has no "this ray was captured" output. A ray whose
// impact parameter is below b_c = 3*sqrt(3)/2 r_s falls into the hole, and the
// trace hands it back with beta left EQUAL to theta. Rendered as an ordinary
// deflection that fills the middle of the image plane with an undistorted copy
// of the source -- precisely where the black hole's SHADOW belongs.
//
// The two populations are eight orders of magnitude apart, so the identity is
// unambiguous to detect: captured rays sit within float32 rounding of theta
// (measured max 8.9e-8 r_s), while every other ray in this field is deflected
// by at least 4 r_s. Measured over the grid, the flagged pixels form a clean
// disk of radius 2.47 r_s against the 2.598 r_s theoretical capture radius.
// The trace works in the hole's OWN r_s, which moves with the mass. Its output
// therefore has to be rebased into the fixed physical frame before ANYTHING is
// drawn or measured against it -- otherwise every length in the scene rides
// along with the black hole: the source galaxy's radius and position are held
// in scene units, so growing the hole silently grew the galaxy too.
//
// One fixed unit throughout the panel: r_s at BH_REF_MASS, written r_s0. The
// frame is always +/-20 r_s0 wide and the galaxy always the size the sliders
// say; what changes with the mass is the hole, whose own r_s is (M/M_ref)
// r_s0 and whose shadow grows with it.
function rebaseToFixedFrame(scene) {
  const k = bh.mass / BH_REF_MASS;          // actual r_s -> r_s0
  for (let i = 0; i < scene.beta1.length; i++) { scene.beta1[i] *= k; scene.beta2[i] *= k; }
  scene.half *= k;                          // half_fov_rs(M) * k == BH_REF_HALF_FOV_RS
  scene.unit_label = 'r_s⁰';
  for (const key of Object.keys(scene.overlays || {})) {
    for (const seg of scene.overlays[key] || []) {
      if (!seg || !seg.x) continue;
      for (let i = 0; i < seg.x.length; i++) { seg.x[i] *= k; seg.y[i] *= k; }
    }
  }
}

function capturedMask(N, half, beta1, beta2) {
  const step = 2 * half / N, eps = 1e-4 * half;
  const mask = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    const ty = -half + (j + .5) * step;
    for (let i = 0; i < N; i++) {
      const idx = i + j * N, tx = -half + (i + .5) * step;
      if (Math.abs(beta1[idx] - tx) < eps && Math.abs(beta2[idx] - ty) < eps) mask[idx] = 1;
    }
  }
  return mask;
}

function compositeOnBeta(sources) {
  const N = SCENE.N, half = SCENE.half;
  if (!N || !SCENE.beta1) return { vals: new Float32Array(0), vmax: 0 };
  const captured = SCENE.captured;
  const step = 2*half/N;
  const vals = new Float32Array(N*N);
  let vmax = 0;
  // Mean configured lens depth (exact for a single lens, the common case; an
  // approximation if lenses sit at different depths -- no single "the" lens
  // depth is well-defined then), used by the perspective-camera rescale
  // formula above.
  const meanLensZ = lensList.length ? lensList.reduce((s,l) => s+(l.z_mpc||0), 0) / lensList.length : 0;
  const D_s_ref = WEAK_D_L_MPC + WEAK_D_LS_MPC;
  // K corrects the PERSPECTIVE camera's raw weak-field beta back onto the
  // img_x/theta scale (see the derivation above). finalizeSchwarzschild
  // already returns beta on that scale -- verified by widening the field
  // until deflection vanishes, where |beta|/|theta| -> 1.000000 -- so applying
  // K there too halved the whole black-hole image plane. Schwarzschild mode
  // takes the traced beta directly, which is what this file's render() comment
  // said it did all along.
  const K = metricMode === 'weak_field' ? WEAK_D_L_MPC / D_s_ref : 1;
  const D_ls_ref_eff = WEAK_D_LS_MPC - meanLensZ;
  for (const src of sources) {
    const pa = src.pa*Math.PI/180, cp = Math.cos(pa), sp = Math.sin(pa);
    const q = 1-src.ellip, bnv = bn(src.ns), inv_n = 1/src.ns, inv_Re = 1/src.Re;
    const D_s_tgt = WEAK_D_L_MPC + meanLensZ + src.D_ls_mpc;
    const ratio2 = (D_s_ref / D_ls_ref_eff) * (src.D_ls_mpc / D_s_tgt);
    const brightness = src.brightness == null ? 1 : src.brightness;
    for (let j = 0; j < N; j++) {
      const thetaY = -half+(j+.5)*step;
      for (let i = 0; i < N; i++) {
        const idx = i+j*N;
        if (captured && captured[idx]) continue;  // inside the shadow: no light reaches the observer
        const thetaX = -half+(i+.5)*step;
        const bx = thetaX*(1-ratio2) + ratio2*K*SCENE.beta1[idx];
        const by = thetaY*(1-ratio2) + ratio2*K*SCENE.beta2[idx];
        const dx = (bx-src.cx)*cp+(by-src.cy)*sp, dy = -(bx-src.cx)*sp+(by-src.cy)*cp;
        const r = Math.sqrt(dx*dx+(dy/q)*(dy/q));
        const nv = vals[idx] + Math.exp(-bnv*(Math.pow(r*inv_Re, inv_n)-1)) * brightness;
        vals[idx] = nv; if (nv > vmax) vmax = nv;
      }
    }
  }
  return { vals, vmax };
}

// Same sources, but on the (unlensed) SOURCE plane: each source shown at its
// own configured (cx,cy) directly, no rescale -- this panel is the intrinsic
// scene, not a projection, so a source's distance doesn't move it here
// (this composer's flat, non-cosmological simplification doesn't model
// distance-dependent angular size either, consistent with the rest of it).
function compositeDirect(sources) {
  const N = SCENE.N, half = SCENE.half;
  if (!N) return { vals: new Float32Array(0), vmax: 0 };
  const step = 2*half/N;
  const vals = new Float32Array(N*N);
  let vmax = 0;
  for (const src of sources) {
    const pa = src.pa*Math.PI/180, cp = Math.cos(pa), sp = Math.sin(pa);
    const q = 1-src.ellip, bnv = bn(src.ns), inv_n = 1/src.ns, inv_Re = 1/src.Re;
    const brightness = src.brightness == null ? 1 : src.brightness;
    for (let j = 0; j < N; j++) {
      const by = -half+(j+.5)*step;
      for (let i = 0; i < N; i++) {
        const idx = i+j*N;
        const bx = -half+(i+.5)*step;
        const dx = (bx-src.cx)*cp+(by-src.cy)*sp, dy = -(bx-src.cx)*sp+(by-src.cy)*cp;
        const r = Math.sqrt(dx*dx+(dy/q)*(dy/q));
        const nv = vals[idx] + Math.exp(-bnv*(Math.pow(r*inv_Re, inv_n)-1)) * brightness;
        vals[idx] = nv; if (nv > vmax) vmax = nv;
      }
    }
  }
  return { vals, vmax };
}

function paintToCanvas(ctx, vals, N, SZ, offX, offY, vmax_ref, I0) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (!N) return;
  const idata = new ImageData(N, N);
  const pix = idata.data;
  const inv = vmax_ref > 1e-12 ? 1/vmax_ref : 0;
  for (let j = 0; j < N; j++) {
    const row = N-1-j;
    for (let i = 0; i < N; i++) {
      const v = vals[i+j*N];
      const t = Math.min(1, Math.sqrt(Math.max(0, v*inv*I0)));
      const ci = Math.round(t*255);
      const b = (row*N+i)*4;
      pix[b] = MLUT[ci*4]; pix[b+1] = MLUT[ci*4+1]; pix[b+2] = MLUT[ci*4+2]; pix[b+3] = 255;
    }
  }
  const off = new OffscreenCanvas(N, N);
  off.getContext('2d').putImageData(idata, 0, 0);
  ctx.drawImage(off, offX, offY, SZ, SZ);
}

function render() {
  const { cx, cy, Re, ns, ellip, pa, I0 } = P;
  // The D_ls_mpc rescale (see compositeOnBeta's comment) is a weak-field/
  // small-deflection result -- not valid near a black hole's strong-field
  // deflections, so multi-distance sources and the background field are
  // weak-field-only. Schwarzschild mode always renders exactly the single
  // primary source at the traced beta directly (D_ls_mpc == WEAK_D_LS_MPC
  // forces the rescale ratio to 1, i.e. a no-op, and the field is dropped
  // entirely), matching this composer's behavior before either existed.
  const weakField = metricMode === 'weak_field';
  const D_ls_mpc = weakField ? P.D_ls_mpc : WEAK_D_LS_MPC;
  const sources = [{ cx, cy, Re, ns, ellip, pa, D_ls_mpc, brightness: 1 }];
  if (weakField && fieldEnabled) sources.push(...fieldSources);
  const { vals: lv, vmax: vm1 } = compositeOnBeta(sources);
  const { vals: sv, vmax: vm2 } = compositeDirect(sources);
  const vmax_ref = Math.max(vm1, vm2, 1e-10);
  paintToCanvas(ctxI, lv, SCENE.N, SZ_img, offI_x, offI_y, vmax_ref, I0);
  paintToCanvas(ctxS, sv, SCENE.N, SZ_src, offS_x, offS_y, vmax_ref, I0);
  drawOverlays();
}
function schedRender() { if (rafId) cancelAnimationFrame(rafId); rafId = requestAnimationFrame(render); }

function mpc2px(x_mpc, y_mpc, SZ_css, offX_css, offY_css, half) {
  const fx = (x_mpc+half)/(2*half), fy = (y_mpc+half)/(2*half);
  return [offX_css + fx*SZ_css, offY_css + (1-fy)*SZ_css];
}
function px2mpc(px_css, py_css, SZ_css, offX_css, offY_css, half) {
  const fx = (px_css-offX_css)/SZ_css, fy = 1-(py_css-offY_css)/SZ_css;
  return [fx*2*half-half, fy*2*half-half];
}
function segs2path(segs, col, SZc, ox, oy, half, sw=1.4, scale=1) {
  if (!segs || !segs.length) return '';
  let out = '';
  for (const seg of segs) {
    if (!seg.x || seg.x.length < 2) continue;
    let d = '';
    for (let k = 0; k < seg.x.length; k++) {
      const [px, py] = mpc2px(seg.x[k]*scale, seg.y[k]*scale, SZc, ox, oy, half);
      d += (k?'L':'M') + px.toFixed(1) + ' ' + py.toFixed(1) + ' ';
    }
    out += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${sw}" opacity=".92"/>`;
  }
  return out;
}
function markerSVG(x_m, y_m, col, SZc, ox, oy, half, sz=8) {
  const [px, py] = mpc2px(x_m, y_m, SZc, ox, oy, half);
  return `<line x1="${px-sz}" y1="${py}" x2="${px+sz}" y2="${py}" stroke="${col}" stroke-width="2" opacity=".95"/>
          <line x1="${px}" y1="${py-sz}" x2="${px}" y2="${py+sz}" stroke="${col}" stroke-width="2" opacity=".95"/>`;
}
function fovBorder(SZc, ox, oy) {
  return `<rect x="${(ox+0.5).toFixed(1)}" y="${(oy+0.5).toFixed(1)}" width="${(SZc-1).toFixed(1)}" height="${(SZc-1).toFixed(1)}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>`;
}

function drawOverlays() {
  const ov = SCENE.overlays || {};
  const SS = SZ_src/DPR, oSx = offS_x/DPR, oSy = offS_y/DPR;
  const SI = SZ_img/DPR, oIx = offI_x/DPR, oIy = offI_y/DPR;
  const half = SCENE.half;
  let si = fovBorder(SS, oSx, oSy);
  let ii = fovBorder(SI, oIx, oIy);
  if (P.showCritTan) ii += segs2path(ov.critical_tangential, 'var(--crit-tan)', SI, oIx, oIy, half, 1.5);
  if (P.showCritRad) ii += segs2path(ov.critical_radial, 'var(--crit-rad)', SI, oIx, oIy, half, 1.3);
  // Caustics come straight from the WASM trace as raw physical positions at
  // world-x=WEAK_D_LS_MPC, on the SAME scale as SCENE.beta1/beta2 in
  // compositeOnBeta -- and subject to the exact same perspective-camera
  // scale mismatch against the half/img_x-based display window (see the big
  // comment above compositeOnBeta): even with zero deflection, that raw
  // position is K^-1 = (WEAK_D_L_MPC+WEAK_D_LS_MPC)/WEAK_D_L_MPC times too
  // large for this window. Metric mode matters here (Schwarzschild's camera
  // is unaffected by the weak-field perspective switch, still effectively
  // orthographic-scaled) so only apply K in weak-field mode.
  const causticScale = metricMode === 'weak_field' ? WEAK_D_L_MPC / (WEAK_D_L_MPC + WEAK_D_LS_MPC) : 1;
  if (P.showCaustTan) si += segs2path(ov.caustic_tangential, 'var(--caust-tan)', SS, oSx, oSy, half, 1.5, causticScale);
  if (P.showCaustRad) si += segs2path(ov.caustic_radial, 'var(--caust-rad)', SS, oSx, oSy, half, 1.3, causticScale);
  if (P.showMark) {
    si += markerSVG(P.cx, P.cy, '#ff6b6b', SS, oSx, oSy, half);
    ii += markerSVG(P.cx, P.cy, 'rgba(255,255,255,.95)', SI, oIx, oIy, half);
  }
  document.getElementById('svg-src').innerHTML = si;
  document.getElementById('svg-img').innerHTML = ii;
}

// ---------------------------------------------------------------------------
// Worker POOL / scene composition
// ---------------------------------------------------------------------------
// Real WASM multithreading (SharedArrayBuffer + pthreads) needs Cross-
// Origin-Opener/Embedder-Policy response headers, which GitHub Pages' static
// file serving cannot set -- so instead of one worker, this runs a POOL of
// independent Workers, each with its OWN WASM module instance and no shared
// memory. No special headers needed at all -- just plain postMessage.
//
// A real pthread-enabled build WAS built and measured (excalibur_scene_
// threaded.wasm/live-worker-threaded.js/coi-serviceworker.js, still present
// in this directory, just not wired up here): cross-origin isolation via a
// service-worker header-injection trick works fine even on GitHub Pages, and
// the std::thread dispatcher itself scales well in isolation (14 threads:
// 5.5x on a full N=256 grid, still ~4x even on a tiny N=16 one). It is NOT
// activated here, but the reason is more nuanced than "measured slower" --
// worth reading before re-attempting this, since two different wrong
// conclusions were reached (and corrected) while measuring it:
//
// 1. First measurement said threaded was ~10x slower. Wrong -- it was
//    comparing a real threaded run against a POOL run that was silently
//    failing on EVERY chunk (adding `nthreads` to the shared embind
//    value_object without updating live-worker.js's non-threaded spec
//    builder to include it too -- embind requires every registered field
//    present -- made every pool chunk throw "Missing field: nthreads", and
//    the pool's error handler resets state to look identical to a normal
//    completed trace). Caught by checking `SCENE.N` directly instead of
//    trusting the status text; see live-worker.js's toWeakFieldSpec/
//    toSchwarzschildSpec for the fix.
// 2. Second measurement, after that fix, said threaded was a real but more
//    modest ~40% slower, and attributed it to a pthread build's shared,
//    atomics-backed linear memory taxing every access. Also wrong, and
//    directly disproved: the threaded BUILD at nthreads=1 (no real
//    threading at all, same serial code path as the non-threaded build)
//    measured *faster* than the plain non-threaded build on the identical
//    N=256 trace (12.6s vs 14.2s) -- so pthread compilation itself is not
//    the tax. The real, larger effect turned out to be a one-time ~1s
//    pthread-pool-spawn cost paid on a fresh page load (PTHREAD_POOL_SIZE
//    pre-spawns real Workers) that a "restart the ladder right after
//    navigating" benchmark pays in full but a returning visitor mostly
//    wouldn't; a `-sALLOW_MEMORY_GROWTH` + `-pthread` combination
//    Emscripten's own linker warns is slow was also swapped for a fixed
//    `-sINITIAL_MEMORY` (wasm/CMakeLists.txt), though that specific change
//    didn't measurably help on its own.
//
// The honest bottom line, once BOTH bugs were accounted for and warm-vs-
// cold was controlled for: threaded and pooled are roughly COMPARABLE for
// this workload, each winning some in-page-timed back-to-back runs and
// losing others, well within this machine's own run-to-run noise (the pool
// architecture's own repeat-run timings varied by ~35% run to run here) --
// not the clear, large win the "real threading" framing implies, and not a
// clear loss either. Given that, and that threading adds real complexity
// (a service-worker dependency, an extra automatic reload on a visitor's
// first-ever page load, a second build artifact, cross-browser behavior
// only checked in Firefox here) for at best a wash, it stays unactivated --
// but "the pool wins because pthreads carry an inherent tax" is NOT an
// accurate reason why, so don't repeat that claim without re-measuring.
//
// Row cost is NOT uniform (a row crossing close to a lens center needs the
// expensive fine-tolerance window, see SceneTrace.hpp's impact-parameter
// culling), so a fixed equal-ROW split per worker leaves some workers idle
// while one straggler finishes the "hot" band. Instead this splits the grid
// into many small CHUNKS (several per worker) and dispatches them as a work
// queue: each worker gets handed the next unclaimed chunk as soon as it
// finishes its last one, so a worker lucky enough to draw only cheap rows
// just processes more of them. Wall-clock time tracks (total work / worker
// count) much more closely than a static split would.
// Each worker instantiates its own copy of the WASM module, so the pool is a
// memory cost as much as a parallelism win. Phones report big.LITTLE core
// counts they cannot actually sustain, hence the tighter cap.
const POOL_SIZE = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, COARSE ? 4 : 16));
const CHUNKS_PER_WORKER = 10;
const pool = Array.from({ length: POOL_SIZE }, () => new Worker('live-worker.js' + ASSET_V));
let requestId = 0;
let currentRequest = null;  // { id, mode, spec, N, queue[], chunksTotal, chunksDone, beta1, beta2, imgX, imgY }

pool.forEach((w, workerIdx) => {
  w.onerror = (err) => {
    document.getElementById('pmsg').textContent = 'Error loading WASM module: ' + err.message;
    console.error(`pool worker ${workerIdx}:`, err);
  };
  w.onmessage = (e) => handlePoolMessage(workerIdx, e);
});

function dispatchNextChunk(workerIdx) {
  const req = currentRequest;
  if (!req || req.queue.length === 0) return;
  const [rowStart, rowEnd] = req.queue.shift();
  pool[workerIdx].postMessage({ id: req.id, kind: 'chunk', mode: req.mode, spec: req.spec, rowStart, rowEnd });
}

function handlePoolMessage(workerIdx, e) {
  const { id, status } = e.data;
  // requestId only increases and is captured at send time in beginTrace();
  // a message whose id doesn't match the CURRENT request is for one that's
  // since been superseded -- e.g. the user tweaked another slider before a
  // higher-resolution refinement rung finished. Silently dropped: the
  // worker that sent it is now free and will pick up the new request's
  // queue the next time beginTrace() dispatches to it.
  if (!currentRequest || id !== currentRequest.id) return;

  if (status === 'done') { handleFinalizeDone(e); return; }

  if (status === 'error') {
    document.getElementById('loading').style.display = 'none';
    console.error(`pool worker ${workerIdx} failed:`, e.data.message);
    currentRequest = null;
    updateLiveStatus();
    return;
  }

  const { idx_start, beta1, beta2, img_x, img_y } = e.data;
  for (let k = 0; k < beta1.length; k++) {
    currentRequest.beta1[idx_start + k] = beta1[k];
    currentRequest.beta2[idx_start + k] = beta2[k];
    currentRequest.imgX[idx_start + k] = img_x[k];
    currentRequest.imgY[idx_start + k] = img_y[k];
  }
  currentRequest.chunksDone++;
  if (!everRendered) {
    const overall = currentRequest.chunksDone / currentRequest.chunksTotal;
    setProgress(overall, `Ray-tracing… ${(overall * 100).toFixed(0)}%`);
  }
  updateLiveStatus();

  if (currentRequest.chunksDone < currentRequest.chunksTotal) {
    dispatchNextChunk(workerIdx);  // keep this worker busy with the next queued chunk, if any
    return;
  }

  // Every chunk traced -- hand the assembled full grid to one pool worker
  // (any of them; they're stateless w.r.t. previous requests) for the fast
  // FD/critical-curve/caustic finalize pass.
  pool[0].postMessage({ id, kind: 'finalize', mode: currentRequest.mode, spec: currentRequest.spec,
                        beta1: currentRequest.beta1, beta2: currentRequest.beta2,
                        img_x: currentRequest.imgX, img_y: currentRequest.imgY });
}

function handleFinalizeDone(e) {
  const { id } = e.data;
  if (!currentRequest || id !== currentRequest.id) return;
  const { ladder, step } = currentRequest;
  SCENE = { N: e.data.N, half: e.data.half, unit_label: e.data.unit_label,
           beta1: e.data.beta1, beta2: e.data.beta2, overlays: e.data.overlays };
  if (currentRequest.mode === 'schwarzschild') rebaseToFixedFrame(SCENE);
  SCENE.captured = currentRequest.mode === 'schwarzschild'
    ? capturedMask(SCENE.N, SCENE.half, SCENE.beta1, SCENE.beta2) : null;
  everRendered = true;
  document.getElementById('loading').style.display = 'none';
  updateInfo();
  schedRender();

  if (step + 1 < ladder.length) {
    beginTrace(ladder, step + 1);  // immediately keep climbing the resolution ladder
  } else {
    currentRequest = null;
    updateLiveStatus();
  }
}

function composeSpec(overrideN) {
  if (metricMode === 'weak_field') {
    const N = overrideN || RESOLUTION_MAX;
    const lenses = lensList.map(l => {
      const t = lensTypeByKind(l.kind);
      return { kind: l.kind, x_mpc: l.x_mpc, y_mpc: l.y_mpc, z_mpc: l.z_mpc || 0, params: t.params.map(p => l.params[p.key]) };
    });
    return { mode: 'weak_field', spec: {
      lenses, N, half_fov_mpc: WEAK_HALF_FOV_MPC,
      D_l_mpc: WEAK_D_L_MPC, D_ls_mpc: WEAK_D_LS_MPC, rtol: 1e-10, atol: 1e-13,
    } };
  }
  // bh.x/bh.y are authored in the fixed frame (r_s0); the trace wants them in
  // the hole's own r_s, which is (M/M_ref) times bigger.
  const toActualRs = BH_REF_MASS / bh.mass;
  return { mode: 'schwarzschild', spec: {
    bh_mass_1e6_msun: bh.mass, x_mpc: bh.x * toActualRs, y_mpc: bh.y * toActualRs,
    N: overrideN || RESOLUTION_MAX, half_fov_rs: bhHalfFovRs(), D_l_rs: bhDlRs(), D_ls_rs: bhDlsRs(),
    rtol: 1e-10, atol: 1e-13,
  } };
}

// Progressive multi-resolution live rendering: every scene edit restarts a
// resolution LADDER from a near-instant low-res pass, then keeps
// automatically climbing toward RESOLUTION_MAX
// (beginTrace() re-invokes itself from handleFinalizeDone() on each rung's
// completion) -- so there's always something on screen almost immediately,
// getting sharper as the pool works through progressively bigger grids. A
// NEW edit mid-refinement just bumps requestId and restarts the ladder from
// rung 0; the old ladder's still-in-flight results get silently dropped by
// handlePoolMessage's stale-id check when they arrive (see there for what
// happens to the worker that was computing them).
// Every rung of the original ladder is still here (16, 32, 64, 112, 160, 208,
// 256), with intermediates filling the gaps below 256 where each step is cheap
// and the visual jump was most obvious. Above 256 the spacing goes roughly
// geometric: cost grows as N^2, so evenly spaced rungs up there would burn far
// more time re-tracing than the extra smoothness is worth. Total ladder work
// is ~2.7x the final pass alone, about what the original ladder already spent.
const RESOLUTION_CHECKPOINTS = [16, 32, 48, 64, 88, 112, 136, 160, 184, 208, 232, 256,
                                320, 420, 550];
function resolutionLadder(target) {
  const rungs = RESOLUTION_CHECKPOINTS.filter((n) => n < target);
  rungs.push(target);
  return rungs;
}

let everRendered = false;

function beginTrace(ladder, step) {
  const id = ++requestId;
  const N = ladder[step];
  const { mode, spec } = composeSpec(N);

  // Work queue: POOL_SIZE * CHUNKS_PER_WORKER small row-ranges (never fewer
  // than 1 row each), consumed on demand as workers finish -- see the pool
  // comment above for why this beats a fixed equal-row split per worker.
  const numChunks = Math.max(1, Math.min(POOL_SIZE * CHUNKS_PER_WORKER, N));
  const queue = [];
  let prev = 0;
  for (let c = 1; c <= numChunks; c++) {
    const next = Math.round((c * N) / numChunks);
    queue.push([prev, next]);
    prev = next;
  }

  currentRequest = {
    id, mode, spec, N, queue, chunksTotal: numChunks, chunksDone: 0, ladder, step,
    beta1: new Array(N * N), beta2: new Array(N * N), imgX: new Array(N * N), imgY: new Array(N * N),
  };

  // The full-screen loading overlay only ever makes sense for the very
  // first paint (before there's anything to show at all); every later
  // ladder run -- whether climbing automatically or restarted by a new
  // edit -- uses the lightweight, non-blocking on-canvas status instead
  // (updateLiveStatus()), since the whole point is to keep interacting
  // while it refines in the background.
  if (!everRendered) {
    document.getElementById('loading').style.display = 'flex';
    setProgress(0, `Ray-tracing ${N}×${N}…`);
  }
  updateLiveStatus();
  for (let w = 0; w < POOL_SIZE; w++) dispatchNextChunk(w);
}

function setProgress(frac, msg) {
  document.getElementById('pfill').style.width = (frac * 100).toFixed(0) + '%';
  document.getElementById('pmsg').textContent = msg;
}

let liveDebounceTimer = null;
function scheduleLiveRecompute() {
  clearTimeout(liveDebounceTimer);
  liveDebounceTimer = setTimeout(() => {
    beginTrace(resolutionLadder(RESOLUTION_MAX), 0);
  }, 80);
}

function updateLiveStatus() {
  const el = document.getElementById('hint');
  // No room for the prose on a phone; the resolution/progress readout is the
  // part that actually carries information while the pool works.
  const lead = MOBILE_LAYOUT() ? '' : 'Drag on the source plane · ';
  if (currentRequest) {
    const target = currentRequest.ladder[currentRequest.ladder.length - 1];
    const pct = currentRequest.chunksTotal ? Math.round(100 * currentRequest.chunksDone / currentRequest.chunksTotal) : 0;
    const refining = currentRequest.N < target
      ? (MOBILE_LAYOUT() ? ` → ${target}` : ` → refining to ${target}×${target}`)
      : '';
    el.textContent = `${lead}${currentRequest.N}×${currentRequest.N}${refining} (${pct}%)`;
  } else {
    const N = SCENE.N || RESOLUTION_MAX;
    el.textContent = `${lead}${N}×${N}`;
  }
}

// ---------------------------------------------------------------------------
// Lens list UI
// ---------------------------------------------------------------------------
function buildAddLensDropdown() {
  const sel = document.getElementById('add-lens-type');
  sel.innerHTML = LENS_TYPES.map(t => `<option value="${t.kind}">${t.label}</option>`).join('');
}

function buildLensList() {
  const wrap = document.getElementById('lens-list');
  wrap.innerHTML = '';
  for (const lens of lensList) {
    const t = lensTypeByKind(lens.kind);
    const card = document.createElement('div');
    card.className = 'lens-card';
    const hdr = document.createElement('div');
    hdr.className = 'lens-card-hdr';
    hdr.innerHTML = `<span class="lens-card-type">${t.label}</span>`;
    const rm = document.createElement('button');
    rm.className = 'lens-rm'; rm.textContent = '×'; rm.title = 'Remove lens';
    rm.addEventListener('click', () => {
      lensList = lensList.filter(l => l.id !== lens.id);
      buildLensList(); scheduleLiveRecompute();
    });
    hdr.appendChild(rm);
    card.appendChild(hdr);

    const posRow = (label, key, min, max) => {
      const row = document.createElement('div'); row.className = 'sl-row';
      const val = lens[key].toFixed(2);
      row.innerHTML = `<div class="sl-hdr"><span class="sl-lbl">${label}</span><span class="sl-val">${val}</span></div>
                        <input type="range" min="${min}" max="${max}" step="0.01" value="${lens[key]}">`;
      const input = row.querySelector('input'), vel = row.querySelector('.sl-val');
      input.addEventListener('input', () => { lens[key] = +input.value; vel.textContent = (+input.value).toFixed(2); scheduleLiveRecompute(); });
      card.appendChild(row);
    };
    posRow('x [Mpc]', 'x_mpc', -2.8, 2.8);
    posRow('y [Mpc]', 'y_mpc', -2.8, 2.8);
    posRow('z (depth) [Mpc]', 'z_mpc', -150, 150);

    for (const p of t.params) {
      const row = document.createElement('div'); row.className = 'sl-row';
      const v = lens.params[p.key];
      row.innerHTML = `<div class="sl-hdr"><span class="sl-lbl">${p.label}</span><span class="sl-val">${v} ${p.unit}</span></div>
                        <input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}">`;
      const input = row.querySelector('input'), vel = row.querySelector('.sl-val');
      input.addEventListener('input', () => {
        lens.params[p.key] = +input.value;
        vel.textContent = `${(+input.value).toPrecision(3)} ${p.unit}`;
        scheduleLiveRecompute();
      });
      card.appendChild(row);
    }
    wrap.appendChild(card);
  }
  updateLiveStatus();
}

document.getElementById('add-lens-btn').addEventListener('click', () => {
  const kind = +document.getElementById('add-lens-type').value;
  const t = lensTypeByKind(kind);
  const params = {}; for (const p of t.params) params[p.key] = p.def;
  lensList.push({ id: nextLensId++, kind, x_mpc: 0, y_mpc: 0, z_mpc: 0, params });
  buildLensList(); scheduleLiveRecompute();
});

// ---------------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------------
// The source-position sliders (sx/sy) share DOM elements across both modes,
// but the two modes use unrelated units/scales (Mpc vs r_s) and FOVs
// (WEAK_HALF_FOV_MPC=3.0 vs the mass-dependent bhHalfFovRs()) -- a fixed range
// left Schwarzschild mode only able to place the source within a fraction
// of its actual (much wider, in its own units) frame. Re-range on every
// mode switch instead, and re-center (a leftover Mpc-space position has no
// meaningful equivalent in r_s-space, or vice versa).
// The displayed frame is a fixed +/-BH_REF_HALF_FOV_RS r_s0 whatever the mass,
// so these stay constants -- and keep the values they always had.
const WEAK_SOURCE_POS_LIMIT = 2.8, BH_SOURCE_POS_LIMIT = 0.9 * BH_REF_HALF_FOV_RS;
function sourcePosLimit() { return metricMode === 'weak_field' ? WEAK_SOURCE_POS_LIMIT : BH_SOURCE_POS_LIMIT; }
function updateSourcePositionRange() {
  const lim = sourcePosLimit();
  const sxEl = document.getElementById('sx'), syEl = document.getElementById('sy');
  sxEl.min = -lim; sxEl.max = lim; syEl.min = -lim; syEl.max = lim;
  P.cx = 0; P.cy = 0;
  sxEl.value = 0; syEl.value = 0;
  document.getElementById('vx').textContent = fmt(0);
  document.getElementById('vy').textContent = fmt(0);
}

document.getElementById('mode-weak').addEventListener('click', () => {
  if (metricMode === 'weak_field') return;
  metricMode = 'weak_field';
  document.getElementById('mode-weak').classList.add('active');
  document.getElementById('mode-bh').classList.remove('active');
  document.getElementById('weak-panel').style.display = '';
  document.getElementById('bh-panel').style.display = 'none';
  document.getElementById('sdls-row').style.display = '';
  document.getElementById('field-panel').style.display = '';
  updateSourcePositionRange();
  scheduleLiveRecompute();
});
document.getElementById('mode-bh').addEventListener('click', () => {
  if (metricMode === 'schwarzschild') return;
  metricMode = 'schwarzschild';
  document.getElementById('mode-bh').classList.add('active');
  document.getElementById('mode-weak').classList.remove('active');
  document.getElementById('weak-panel').style.display = 'none';
  document.getElementById('bh-panel').style.display = '';
  // Multi-distance sources/field are a weak-field-only approximation (see
  // render()'s comment) -- hidden, not just ignored, in Schwarzschild mode.
  document.getElementById('sdls-row').style.display = 'none';
  document.getElementById('field-panel').style.display = 'none';
  updateSourcePositionRange();
  scheduleLiveRecompute();
});

function setupBhSliders() {
  const sm = document.getElementById('s-bhmass'), vm = document.getElementById('v-bhmass');
  sm.addEventListener('input', () => {
    bh.mass = +sm.value;
    vm.textContent = `${(+sm.value).toFixed(1)}×10⁶ M☉`;
    scheduleLiveRecompute();
  });
  const sxEl = document.getElementById('s-bhx'), vxEl = document.getElementById('v-bhx');
  sxEl.addEventListener('input', () => { bh.x = +sxEl.value; vxEl.textContent = fmt(+sxEl.value, 1); scheduleLiveRecompute(); });
  const syEl = document.getElementById('s-bhy'), vyEl = document.getElementById('v-bhy');
  syEl.addEventListener('input', () => { bh.y = +syEl.value; vyEl.textContent = fmt(+syEl.value, 1); scheduleLiveRecompute(); });
}

// ---------------------------------------------------------------------------
// Info panel
// ---------------------------------------------------------------------------
function updateInfo() {
  const el = document.getElementById('info-block');
  if (metricMode === 'weak_field') {
    el.innerHTML =
      `<b>Weak-field multi-lens</b><br>` +
      `<div class="row"><span>Lenses</span><span>${lensList.length}</span></div>` +
      `<div class="row"><span>Grid</span><span>${SCENE.N}×${SCENE.N}</span></div>` +
      `<div class="row"><span>D_l, D_ls</span><span>${WEAK_D_L_MPC}, ${WEAK_D_LS_MPC} Mpc</span></div>` +
      `<div class="note">Simplified flat, non-cosmological weak-field (linearized GR) lensing — a static lens/source plane at fixed distances, NOT the precomputed gallery's expanding-universe (z_l=1, z_s=2) pipeline. Real weak-field deflection, simpler geometry, chosen for live interactivity.</div>`;
  } else {
    el.innerHTML =
      `<b>Schwarzschild black hole</b><br>` +
      `<div class="row"><span>Mass</span><span>${bh.mass.toFixed(1)}×10⁶ M☉</span></div>` +
      `<div class="row"><span>Grid</span><span>${SCENE.N}×${SCENE.N}</span></div>` +
      `<div class="row"><span>Field of view</span><span>±${BH_REF_HALF_FOV_RS} r_s⁰ (fixed)</span></div>` +
      `<div class="row"><span>This hole's r_s</span><span>${(bh.mass / BH_REF_MASS).toFixed(2)} r_s⁰</span></div>` +
      `<div class="row"><span>r_s⁰</span><span>r_s at ${BH_REF_MASS}×10⁶ M☉</span></div>` +
      `<div class="note">Exact strong-field geodesics (isotropic Schwarzschild metric) — real photon-sphere bending and a captured-photon shadow, not a weak-field approximation. Distinct from the precomputed gallery's "Schwarzschild" entry, which is actually a weak-field point mass.</div>`;
  }
}

function fmt(v, d=3) { return (v>=0?'+':'') + v.toFixed(d); }

function setupSliders() {
  const sl = [
    ['sx','vx', v=>{P.cx=+v;return fmt(+v)}],
    ['sy','vy', v=>{P.cy=+v;return fmt(+v)}],
    ['sre','vre', v=>{P.Re=+v;return(+v).toFixed(3)}],
    ['sn','vn', v=>{P.ns=+v;return(+v).toFixed(1)}],
    ['se','ve', v=>{P.ellip=+v;return(+v).toFixed(2)}],
    ['spa','vpa', v=>{P.pa=+v;return(+v).toFixed(0)+'°'}],
    ['si0','vi0', v=>{P.I0=+v;return(+v).toFixed(2)+'×'}],
    ['sdls','vdls', v=>{P.D_ls_mpc=+v;return Math.round(+v)+''}],
  ];
  for (const [id, vid, fn] of sl) {
    const el = document.getElementById(id), vel = document.getElementById(vid);
    el.addEventListener('input', () => { vel.textContent = fn(el.value); schedRender(); });
  }
  document.getElementById('breset').addEventListener('click', () => {
    [['sx',0],['sy',0],['sre',0.1],['sn',1.0],['se',0.3],['spa',30],['si0',1.0],['sdls',WEAK_D_LS_MPC]]
      .forEach(([id,v]) => document.getElementById(id).value = v);
    P.cx=0; P.cy=0; P.Re=0.1; P.ns=1.0; P.ellip=0.3; P.pa=30; P.I0=1.0; P.D_ls_mpc=WEAK_D_LS_MPC;
    [['vx','+0.000'],['vy','+0.000'],['vre','0.100'],['vn','1.0'],['ve','0.30'],['vpa','30°'],['vi0','1.00×'],['vdls',WEAK_D_LS_MPC]]
      .forEach(([id,v]) => document.getElementById(id).textContent = v);
    schedRender();
  });
}

function setupFieldControls() {
  const ovRow = document.getElementById('ov-field');
  ovRow.addEventListener('click', () => {
    fieldEnabled = !fieldEnabled;
    ovRow.classList.toggle('on', fieldEnabled);
    if (fieldEnabled && fieldSources.length === 0) {
      fieldSources = generateField(FIELD.count, FIELD.dMin, FIELD.dMax);
    }
    schedRender();
  });

  const fl = [
    ['sfcount','vfcount', v=>{FIELD.count=Math.round(+v);return FIELD.count+''}],
    ['sfdmin','vfdmin', v=>{FIELD.dMin=+v;return Math.round(+v)+''}],
    ['sfdmax','vfdmax', v=>{FIELD.dMax=+v;return Math.round(+v)+''}],
  ];
  for (const [id, vid, fn] of fl) {
    const el = document.getElementById(id), vel = document.getElementById(vid);
    // Count/distance-range changes only take effect on the next regenerate
    // (mid-drag reshuffling of the whole field would be visually chaotic) --
    // just update the displayed value and the FIELD target here.
    el.addEventListener('input', () => { vel.textContent = fn(el.value); });
  }

  document.getElementById('bfregen').addEventListener('click', () => {
    fieldSources = generateField(FIELD.count, FIELD.dMin, FIELD.dMax);
    if (fieldEnabled) schedRender();
  });
}

function setupOverlays() {
  [['ov-crit-tan','showCritTan'],['ov-crit-rad','showCritRad'],
   ['ov-caust-tan','showCaustTan'],['ov-caust-rad','showCaustRad'],
   ['ov-mark','showMark']].forEach(([id,key]) => {
    const row = document.getElementById(id);
    row.addEventListener('click', () => { P[key] = !P[key]; row.classList.toggle('on', P[key]); drawOverlays(); });
  });
}

function eventToCanvasCssPx(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}
// Source coordinates read from the canvas title on desktop and from the bottom
// bar on phones, where the title is too cramped to scan at a glance.
function setSrcCoordText(mx, my) {
  const t = `β=(${mx.toFixed(3)}, ${my.toFixed(3)})`;
  document.getElementById('coord-src').textContent = `${t} ${SCENE.unit_label}`;
  const mb = document.getElementById('mb-coord');
  if (mb) mb.textContent = t;
}

function applyDrag(e) {
  const [px, py] = eventToCanvasCssPx(e, csrc);
  const SS = SZ_src/DPR, oSx = offS_x/DPR, oSy = offS_y/DPR;
  let [mx, my] = px2mpc(px, py, SS, oSx, oSy, SCENE.half);
  const lim = sourcePosLimit();
  mx = Math.max(-lim, Math.min(lim, mx));
  my = Math.max(-lim, Math.min(lim, my));
  P.cx = mx; P.cy = my;
  document.getElementById('sx').value = mx; document.getElementById('sy').value = my;
  document.getElementById('vx').textContent = fmt(mx); document.getElementById('vy').textContent = fmt(my);
  setSrcCoordText(mx, my);
  schedRender();
}
function setupDrag() {
  csrc.addEventListener('mousedown', e => { dragging = true; applyDrag(e); });
  window.addEventListener('mousemove', e => {
    if (dragging) { applyDrag(e); return; }
    if (e.target === csrc) {
      const [px, py] = eventToCanvasCssPx(e, csrc);
      const SS = SZ_src/DPR, oSx = offS_x/DPR, oSy = offS_y/DPR;
      const [mx, my] = px2mpc(px, py, SS, oSx, oSy, SCENE.half);
      setSrcCoordText(mx, my);
    }
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  // Follow one finger only: reading touches[0] unconditionally let any second
  // finger anywhere on screen hijack the source marker mid-drag.
  let touchId = null;
  const findTouch = (list) => {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === touchId) return list[i];
    return null;
  };
  csrc.addEventListener('touchstart', e => {
    if (dragging || !e.changedTouches.length) return;
    touchId = e.changedTouches[0].identifier;
    dragging = true;
    applyDrag(e.changedTouches[0]);
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', e => {
    if (!dragging) return;
    const t = findTouch(e.touches);
    if (!t) return;
    applyDrag(t);
    e.preventDefault();
  }, { passive: false });
  const touchEnd = (e) => {
    if (!dragging) return;
    if (e && e.changedTouches && !findTouch(e.changedTouches)) return;
    dragging = false; touchId = null;
  };
  window.addEventListener('touchend', touchEnd);
  window.addEventListener('touchcancel', touchEnd);
  cimg.addEventListener('mousemove', e => {
    const [px, py] = eventToCanvasCssPx(e, cimg);
    const SI = SZ_img/DPR, oIx = offI_x/DPR, oIy = offI_y/DPR;
    const [mx, my] = px2mpc(px, py, SI, oIx, oIy, SCENE.half);
    document.getElementById('coord-img').textContent = `θ=(${mx.toFixed(3)}, ${my.toFixed(3)}) ${SCENE.unit_label}`;
  });
}

// ---- Bottom sheet (phones): the sidebar slides up over the canvases ----
function sheetOpen(v) {
  const side = document.getElementById('side');
  side.classList.toggle('open', v);
  document.getElementById('sheet-backdrop').classList.toggle('on', v);
  if (v) side.scrollTop = 0;
}
function isSheetOpen() { return document.getElementById('side').classList.contains('open'); }

function setupSheet() {
  document.getElementById('mb-controls').addEventListener('click', () => sheetOpen(!isSheetOpen()));
  document.getElementById('sheet-close').addEventListener('click', () => sheetOpen(false));
  document.getElementById('sheet-backdrop').addEventListener('click', () => sheetOpen(false));
  document.getElementById('mb-reset').addEventListener('click', () => document.getElementById('breset').click());
  // Leaving the phone layout must not strand the sidebar in "open" state
  const mq = window.matchMedia('(max-width:900px)');
  if (mq.addEventListener) mq.addEventListener('change', ev => { if (!ev.matches) sheetOpen(false); });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') sheetOpen(false);
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'r' || e.key === 'R') document.getElementById('breset').click();
  if (e.key === 't') document.getElementById('ov-crit-tan').click();
  if (e.key === 'y') document.getElementById('ov-crit-rad').click();
  if (e.key === 'c') document.getElementById('ov-caust-tan').click();
  if (e.key === 'v') document.getElementById('ov-caust-rad').click();
});

let resizeTimer = null;
function onViewportChange() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { setupSize(); updateLiveStatus(); schedRender(); }, 120);
}
window.addEventListener('resize', onViewportChange);
// Phones: rotation and the collapsing address bar both change the usable box
window.addEventListener('orientationchange', onViewportChange);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);

function init() {
  setupSize();
  buildAddLensDropdown();
  buildLensList();
  setupBhSliders();
  setupSliders();
  setupFieldControls();
  setupOverlays();
  setupDrag();
  setupSheet();
  updateSourcePositionRange();
  updateInfo();
  updateLiveStatus();
  // Same progressive ladder as any later edit -- the very first paint is
  // low-res almost immediately, then sharpens automatically.
  beginTrace(resolutionLadder(RESOLUTION_MAX), 0);
}
init();
