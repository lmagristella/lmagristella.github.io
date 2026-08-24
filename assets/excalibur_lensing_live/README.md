# EXCALIBUR live lensing composer — build notes

`excalibur_scene.wasm` / `excalibur_scene.js` are **committed build
artifacts**, not source. This site has no CI (`.github/workflows/` doesn't
exist — plain GitHub Pages Jekyll auto-build from the branch), so there is no
automated step that (re)compiles them. Any change to
`excalibur-cpp/include/excalibur/scene/*` or
`excalibur-cpp/wasm/scene_bindings.cpp` requires a **manual rebuild and
recopy**:

```sh
# one-time setup
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest

# every rebuild
source ~/emsdk/emsdk_env.sh
cd /path/to/excalibur-cpp
emcmake cmake -S wasm -B build-wasm -DCMAKE_BUILD_TYPE=Release
cmake --build build-wasm
cp build-wasm/excalibur_scene.{wasm,js} \
   /path/to/lmagristella.github.io/assets/excalibur_lensing_live/
```

Record the emsdk version used (`emcc --version`) somewhere retrievable (e.g.
this repo's commit message) when you rebuild — Emscripten output isn't
guaranteed bit-stable across versions, so a future rebuild with a different
emsdk is the most likely source of an unexplained regression. Built with
emsdk `6.0.6` / emcc `6.0.6` as of this writing.

## Why this page exists

`../excalibur_lensing_webapp/` is a curated, precomputed gallery (8 fixed
lens profiles, cosmological `PerturbedFLRW` pipeline, ~56MB of committed
`.bin` grids) — it is untouched by this page and stays the canonical
pedagogical walkthrough. This page is an **additive** live composer: pick
any mix of lenses (or a Schwarzschild black hole) and the deflection field is
ray-traced **in-browser** via WebAssembly, not fetched from a precomputed
asset. See `../../include/excalibur/scene/SceneTrace.hpp` in `excalibur-cpp`
for the physics/architecture notes (why `GeodesicSystem` not `SachsSystem`,
why the weak-field mode is a flat non-cosmological simplification, the
Schwarzschild captured-ray performance fix, etc).

## Files

- `index.html` — page structure + CSS (mostly copied from the gallery page).
- `live.js` — composer UI logic + the rendering pipeline (also mostly copied
  from the gallery page's inline script — `paintToCanvas`/`segs2path`/
  `drawOverlays`/`mpc2px`/`px2mpc`/the Sérsic source-light sliders/drag-to-
  move-source are verbatim, since they already only consume
  `{beta1, beta2, overlays, N, half}`).
- `live-worker.js` — one instance runs per POOL worker (see below); each
  loads its own WASM module copy and handles two message kinds: `'chunk'`
  (trace ONE small row-range, handed out by the main thread's work queue,
  via `traceWeakFieldChunk`/`traceSchwarzschildChunk`) and `'finalize'` (run
  `finalizeWeakField`/`finalizeSchwarzschild` once on the complete assembled
  grid for critical-curve/caustic extraction). **Important**: always convert
  a lens-type integer to the real `M.LensKind.*` embind enum constant before
  building a `LensSpec` — passing a raw JS number for the `kind` field does
  NOT throw, it silently constructs the *wrong* lens type (confirmed
  empirically while building this: a raw `kind=2` produced zero critical-
  curve segments for a scene that should have one). See `kindEnum()` in this
  file.
- `excalibur_scene.wasm` / `excalibur_scene.js` — the build artifacts
  described above.
- `excalibur_scene_threaded.wasm` / `excalibur_scene_threaded.js`,
  `live-worker-threaded.js`, `coi-serviceworker.js` — a real WASM-pthreads
  build and its supporting worker/service-worker, built and measured but
  **not wired up** (`index.html` doesn't load `coi-serviceworker.js`) —
  see "Parallelism" below for why (measured slower than the POOL
  architecture, not a missing capability). Kept for reference/future
  re-evaluation, not dead weight to delete.

## Resolution / compute model: progressive live rendering, no button

Every scene edit (add/remove/tweak a lens, drag a BH slider, switch modes)
triggers a debounced (`scheduleLiveRecompute()`, 80ms, just enough to
coalesce a rapid slider drag into one restart) resolution LADDER
(`resolutionLadder()`/`beginTrace()` in `live.js`): trace a near-instant
low-res pass (N=16), render it, then automatically keep climbing through
`RESOLUTION_CHECKPOINTS = [16, 32, 64, 112, 160, 208, 256]` up to the
`pickGridSize()`-calibrated target — each rung replaces what's on screen as
soon as it's ready, via the SAME chunked pool (`beginTrace()` re-invokes
itself from `handleFinalizeDone()` on every rung's completion). There is no
"Compute" button and nothing blocks interaction: editing a slider
mid-refinement just bumps `requestId` and restarts the ladder from N=16
immediately — the old ladder's still-in-flight higher-resolution results get
silently dropped by `handlePoolMessage`'s stale-id check when they eventually
arrive. Checkpoint count and target resolutions have both been raised twice
on request now: `pickGridSize()`'s tiers are currently **320/200/140/100**
(started at 192/128/96/64), `BH_N` is **320** (started at 192) — reached
through 8 rungs (started at 4). Measured in-browser: the first (16×16) rung
of a fresh edit lands within ~100ms of the debounce firing; a full climb to
the current N=320 default target takes **~10-12s** (weak-field, at the
composer's current ±3.0 Mpc FOV, N=320 up from N=256 the last time this was
measured too — see the cull_radius re-tune note below for why this got
slower than an earlier ~4s figure at N=256/a wider original FOV, and why
that FOV change wasn't reverted to chase the old number back; run-to-run
variance on the dev machine used for these numbers is itself ~15-35%, so
treat any single figure in this document as an order-of-magnitude, not a
guarantee). A small on-canvas
status (`updateLiveStatus()`, repurposing the old usage-hint element) shows
the current rung and, while still refining, the target it's climbing toward.

This replaced an earlier explicit-button design (edit → "Compute lensing" →
wait for one fixed-resolution result) once the accumulated speedups below
made even the FULL target resolution fast enough that racing it against a
cheap low-res preview, rather than gating everything behind a click, became
the better tradeoff.

Field of view is `WEAK_HALF_FOV_MPC = 3.0` Mpc (weak-field) / `BH_HALF_FOV_RS
= 20.0` r_s (Schwarzschild — independent of the weak-field value). History:
started at 4.0, zoomed to 1.5 on request to match the precomputed gallery's
own `half≈1.47-1.50` Mpc framing, then widened back out to 3.0 on request
once that 1.5 turned out to cost more than expected (see the cull_radius
re-tune note below) — 3.0 is a middle ground, more zoomed than the original
4.0, noticeably cheaper than 1.5. The lens position sliders clamp to ±2.8
Mpc, leaving a small margin inside the weak-field frame. The **source**-
position sliders (`sx`/`sy`) are mode-aware (`sourcePosLimit()`/
`updateSourcePositionRange()` in `live.js`, re-ranged and re-centered on
every mode switch) since the two modes don't share a coordinate scale: ±2.8
Mpc in weak-field mode, ±18 r_s in Schwarzschild mode. The fine-tolerance
window (`window_half`, `excalibur/scene/SceneTrace.hpp`) stays fixed
regardless of FOV (it's calibrated to the *lens's own* cusp-resolution
needs, not the FOV) — which is what makes the impact-parameter culling below
pay off once the FOV exceeds the window.

## Lens depth (line-of-sight position)

Each lens's position slider set gained a third axis, `z_mpc` (labeled
"z (depth)" in the UI, ±150 Mpc), an offset along the *line of sight* from
the nominal lens plane (world x=0, the plane the camera looks straight
through) rather than across it. This needed no change to any `LensProfile`
(PointMass, NFW, ...): every one of them already takes a genuine 3D
`Vec3<T>` position (verified directly — e.g. `lens/PointMass.hpp`/
`lens/NFW.hpp` both compute a real 3D radius `|p - center|`, not a
2D-projected one), so a nonzero z_mpc is physically meaningful with zero
lens-class changes — `make_any_lens()` in `SceneTrace.hpp` just stops
hardcoding the center's line-of-sight component to 0.

**First version widened the window instead of moving it — wrong call,
reverted.** The fine-tolerance window is centered at world x=0 and sized for
a lens sitting exactly there; a lens offset in depth moves its own cusp away
from that center. The first implementation compensated by making
`window_half` grow with the deepest configured `|z_mpc|` so the (still
x=0-centered) window would still reach it. This worked and was bit-exact at
z=0, but directly defeated the point of a depth slider: widening the window
also widens the expensive fine-tolerance region, so a large, clearly-visible
depth offset (the kind actually worth dragging to) became expensive enough
to time out a 3-minute benchmark at z=±100 Mpc. **Fixed at the root**:
`integrate_windowed()` now takes a `window_center` parameter, and the
per-ray dispatch in `trace_weak_field_chunk` finds whichever configured lens
is transversely closest to *that* ray (already computing this for the
impact-parameter cull check, just tracking the minimum now instead of
stopping at the first hit) and centers the window on *that lens's own*
`z_mpc`. `window_half` itself is back to the exact original fixed 1.5 Mpc,
unconditionally — its cost no longer depends on `z_mpc` at all, only its
*position* along the ray does, which is free to move. (Not exact for a ray
that happens to pass close to two lenses at very different depths at once —
an accepted, undocumented-elsewhere edge case; the common case, one
dominant lens per ray, is exactly what the impact-parameter cull already
selects for.)

**Physics validation superseded, see below.** The original check here
compared the traced ring against an *orthographic*-camera thin-lens
approximation (accounting for the change in `D_ls` from a moving lens but
not the accompanying change in `D_l`, since the orthographic camera made
`D_l` irrelevant in the first place). Once the camera switched to
perspective ("## Perspective camera" section below), the *exact*
point-source formula applies and the ring radius now matches it to <0.3%
across the same range — see that section for the full sweep and, more
importantly, for a genuinely non-obvious physics distinction this depth
slider surfaces (physical vs. apparent Einstein radius) that the
orthographic camera had been silently hiding.

Performance is what the window-recentering fix above was for and is
unaffected by the later camera switch: **flat ~190-230ms per trace across
the entire z sweep** (N=96, re-measured after switching to perspective; the
absolute number differs from an earlier N=96 orthographic figure quoted
here previously, but the flatness — no blowup at any `z` — is the actual
claim and still holds), compare to the pre-recentering version, which didn't
even finish a single N=256 trace at z=±100 within a 3-minute timeout.

## Perspective camera (physically correct D_l dependence)

The weak-field camera was **orthographic** through everything above: parallel
rays, each with a fixed per-pixel transverse offset independent of distance.
That's a real simplification, and a physically consequential one — it made
every ray's impact parameter at the lens independent of `D_l` by
construction, which silently removes a standard, textbook lensing effect
(asked about directly at one point during development: "isn't lensing
efficiency maximal for a lens at roughly the midpoint between observer and
source?" — yes, and the orthographic camera couldn't show it). Switched to
**perspective** (`CameraProjection::Perspective`, already existed in
`excalibur/raytrace/Camera.hpp` — no core-library change needed): rays now
fan out at different *angles* from the single observer point, matching the
standard lens equation `beta = theta - alpha_hat(theta)*(D_ls/D_s)` used
throughout the literature rather than a distance-blind approximation of it.
`fov_x` is derived as `2*atan(half_fov_mpc/D_l)` so the physical half-width
at the *nominal* lens plane (world x=0, distance `D_l` from the observer)
still matches the existing `half_fov_mpc` UI slider exactly — the FOV
control's meaning didn't change, only the ray geometry behind it.

**This surfaced two more orthographic-only assumptions, both bugs once
perspective made them wrong:**

- **Impact-parameter culling** (`trace_weak_field_chunk`'s per-ray dispatch)
  used to read a ray's raw starting position as its transverse offset — valid
  under orthographic (every ray already carries its own fixed offset there)
  but meaningless under perspective, where *every* ray starts at the same
  observer point. Fixed by extrapolating each ray's straight-line position to
  each configured lens's own x, using the ray's initial momentum direction
  (`geo_u`) — exact for orthographic (reduces to the old check bit-for-bit,
  since the momentum's transverse component is exactly zero there) and the
  necessary generalization for perspective.
- **`fill_grid_range`'s `img_x`/`img_y`** had the identical bug, one level
  deeper: it also read a ray's raw starting position, which is identically
  `(0,0)` for *every* perspective ray — collapsing the whole image-plane grid
  to a single point and breaking the finite-difference spacing critical-curve
  detection depends on. Regression was immediate and total, not subtle: a
  scene with a known analytic Einstein ring went from finding it to finding
  **zero** critical-curve segments. Same extrapolation fix, applied at world
  x=0 instead of at each lens's own position (this is the reference plane the
  UI's grid coordinates are actually defined in) — and, satisfyingly, the
  fix is the *same formula* in both places, just evaluated at a different
  target x.

`tests/test_scene.cpp`'s Einstein-ring check was updated from the
orthographic-specific `b_E = sqrt(4GM*D_ls/c^2)` to the standard point-source
formula `b_E = sqrt(4GM/c^2 * D_l*D_ls/D_s)` to match — passes again after
both fixes above, plus the full existing suite (`ctest`, all 5 targets).

**Validated with a native depth sweep, and this is where the physics gets
genuinely interesting.** Two different "Einstein radius" quantities exist
once a lens can sit away from the midpoint, and they behave *differently*:

- The **physical** Einstein radius at the lens itself,
  `b_E(z) = sqrt(4GM/c^2 * D_l_eff*D_ls_eff/D_s)` (with `D_l_eff = D_l+z`,
  `D_ls_eff = D_ls-z`, `D_s` fixed) — this is the standard lensing-efficiency
  quantity, and it genuinely **peaks at the midpoint** (`D_l_eff = D_ls_eff`,
  i.e. `z=0` for this composer's default `D_l=D_ls=300`): measured
  `0.132 → 0.179 → 0.208 → 0.226 → 0.236 → 0.240 (peak, z=0) → 0.236 → 0.226
  → 0.208 → 0.179 → 0.132` Mpc across `z = -250..+250`. This confirms the
  textbook result directly.
- The **apparent** (image-plane) Einstein radius — what's actually traced
  into `img_x`/`img_y` and rendered on screen, extrapolated to the nominal
  x=0 plane — is `b_E(z) * D_l/D_l_eff`, which is proportional to the
  standard *angular* Einstein radius `theta_E`. This does **not** peak at the
  midpoint: it grows monotonically as the lens approaches the observer
  (nearby things look angularly bigger) and shrinks monotonically as it
  approaches the source, hitting the same reference value at `z=0` but never
  turning over. Measured against this exact prediction across `z =
  -200..+250` (N=64, half_fov=0.5 Mpc): worst-case error 0.3%; `z=-250` was
  excluded from that range deliberately, not because it fails — at that
  depth the predicted apparent ring (~0.79 Mpc) genuinely falls outside a 0.5
  Mpc half-FOV, so the "failure" there is just the ring being off-screen, a
  FOV-sizing artifact of the test script, not a tracer bug.

**So: dragging the depth slider will visibly grow or shrink the on-screen
ring monotonically, not bump-then-decline** — confirmed in-browser
(headless Firefox, PointMass at 4×10¹⁵ M☉, z swept from 0 → +150 → -120: ring
visibly shrank then grew past its original size, exactly as the `D_l/D_l_eff`
factor predicts). The "peaks at the midpoint" result is real, but it lives in
the lens's own deflection strength/cross-section, not in what a fixed-frame
image shows you — a genuinely non-obvious distinction, and exactly the kind
of thing an orthographic camera hides by making both quantities collapse
into one (D_l-independent) number.

Performance: re-checked both prior perf fixes still hold under the new ray
geometry — depth-flatness (native, single NFW lens, N=96, half_fov=3.0):
**~190-230ms flat across the full z=-150..+150 sweep**, no blowup; the
`cull_radius=0.20` stress-scene case (concentration=15, near a grid vertex):
**~170ms at z=0 vs. ~169ms at z=100**, no meaningful depth-dependent
regression either.

## Background field: multiple sources at independent distances

The source panel now supports more than one source at once: the existing
draggable primary source gained its own **Distance [Mpc]** slider
(`P.D_ls_mpc`, defaults to the reference `WEAK_D_LS_MPC`), and a whole
**Background field** panel adds a scatter of additional Sersic sources
("stars/galaxies", `fieldSources` in `live.js`) — count, a near/far distance
*range* (each field member's own distance is drawn randomly from between
them, not two literal fixed positions — the UI copy spells this out
explicitly after this being unclear on first look), and a "New random
field" regenerate button. Off by default (`fieldEnabled = false`); a scene
with no field configured renders exactly as it did before this existed.

**This needed zero additional WASM calls.** The trace itself still runs
exactly once, at one fixed reference distance (`WEAK_D_LS_MPC`) — every
other source's own beta position is a closed-form rescale of that SAME
traced field, computed entirely client-side in `compositeOnBeta()`. For a
fixed lens configuration in the weak-field/small-deflection regime, the
reduced deflection angle `alpha_hat(impact parameter)` does not depend on
the source's own distance — only the final transverse shift
(`alpha_hat * remaining path length FROM THE LENS to the source`) does.

**Re-derived once the camera switched to perspective, TWICE — the first
attempt shipped a real bug that only visual inspection caught, not
validation.** The first re-derivation (raw-position extrapolation: `beta =
A*theta + ratio*beta_ref`, a straightforward generalization of the
pre-perspective formula) was internally consistent and passed a from-scratch
re-trace check across a `(z0, D_ls')` grid to 0.0003 pixel-widths — but that
check only ever compared the formula's output against *other raw traced
positions*, never against what the source-plane panel and its position
sliders actually display. It missed a real, visible bug: under perspective,
a ray's raw traced position at world-x=`Xr` is **not** on the same physical
scale as `img_x` (its position extrapolated to world-x=0) even with *zero*
deflection — at this composer's `D_l=Xr=300`, an undeflected ray's raw beta
is exactly 2x its `img_x` (confirmed directly: a weak-lens corner pixel gave
`img_x=-2.9375`, raw `beta=-5.8745`, ratio `1.999834`). Since the source
position sliders (`cx`/`cy`) and the display window both live on the
`img_x`/`half` scale, using raw beta directly put every rendered image at
roughly 2x the position/scale the source-plane panel agreed on with the
sliders — reported directly by inspection ("il y'a un ecart de visualisation
entre le plan image et le plan source... les images sont pas confinés aux
mêmes endroits"), and confirmed once looked for: a lens exactly on the
optical axis with a compact centered source, which should render a bright
glowing Einstein ring, instead rendered only the (separately-computed,
therefore correct) critical-curve *outline* with no visible lensed image
glow along it at all — the glow's brightness peak had been scaled off into
essentially empty space.

**Fixed by working in angles, the standard textbook convention** (`beta =
theta - alpha_hat(theta)*D_ls/D_s`, both `beta` and `theta` angular), then
converting to a displayed length via the *same* fixed scale (`D_l`) `img_x`
already uses — this forces `beta` and `theta` onto one shared, consistent
scale by construction, for any lens depth and any source distance, rather
than requiring every consumer to remember a case-by-case correction. Writing
`D_l = WEAK_D_L_MPC`, `Xr = WEAK_D_LS_MPC`, `z0` for the mean configured lens
depth, `D_ls'` for a source's own (lens-to-source) distance, and
`beta_ref(theta)` for the already-traced raw position at world-x=`Xr`:

```
D_s_ref      = D_l + Xr                    (fixed: observer to reference source)
K            = D_l / D_s_ref                (fixed scale-correction constant, 0.5 here)
D_ls_ref_eff = Xr - z0                       (actual reference lens->source distance)
D_s_tgt      = D_l + z0 + D_ls'              (observer to actual target source)
ratio2       = (D_s_ref/D_ls_ref_eff) * (D_ls'/D_s_tgt)
beta         = theta*(1-ratio2) + ratio2*K*beta_ref(theta)
```

The derivation carries its own sanity check: for an **undeflected** ray
(`beta_ref = theta*(Xr+D_l)/D_l` exactly, no lens involved), this reduces to
`beta = theta` for *any* `z0`/`D_ls'` — an unlensed ray must show the source
at its true position, which is exactly the constraint that pins down `K`'s
definition. **Validated against real re-traces with the same K-correction
applied to each side before comparing** (so the check itself can't hide the
same class of bug again) across the same `(z0, D_ls')` grid as before: worst
case **0.0001 pixel-widths**. Visually re-confirmed too: the same on-axis
point-mass/centered-source scene that had silently failed now renders a
bright, correctly-scaled glowing Einstein ring exactly coincident with the
critical-curve outline; an off-axis lens (source at the origin, lens offset
0.8 Mpc) renders the expected two-image configuration — a bright primary
image near the source's true position and a faint, correctly-positioned
secondary image on the opposite side of the lens, closer to its center.

**The same bug, independently, in the caustic overlay** — `ov.caustic_tangential`/
`ov.caustic_radial` come straight from the WASM trace as raw physical
positions at world-x=`Xr` (`Segment::sx`/`sy` in `SceneTrace.hpp`, fed
directly from `beta1`/`beta2` with no correction), then get drawn on the
source-plane panel against the same `half`-scaled window — subject to the
exact same K-scale mismatch, entirely independently of `compositeOnBeta`
(this is C++/WASM output, not a JS rescale). Fixed client-side rather than
in C++ (the WASM output itself is a perfectly valid raw trace; this is a
display-convention mismatch, not a computation bug) — `segs2path()` gained a
`scale` parameter, applied as the same fixed `K = WEAK_D_L_MPC /
(WEAK_D_L_MPC + WEAK_D_LS_MPC)` before projecting to pixels (a single
constant suffices here, unlike `compositeOnBeta`'s per-source `ratio2` — the
caustic is always tied to the ONE reference trace, not a rescale target).
Schwarzschild mode's caustics are unaffected (its camera stayed the
orthographic-equivalent setup, untouched by this switch) — `causticScale` is
explicitly `1` outside `weak_field` mode. Re-confirmed visually: the
degenerate point caustic for a point-mass lens offset to (0.8, 0) now
appears at (0.8, 0) in the source panel, matching the lens's own position
exactly (the textbook result for a point mass — the tangential caustic is a
single point at the lens's own image-plane position) instead of roughly
double that distance.

**Lesson for next time, worth restating**: a from-scratch re-derivation that
only checks itself against other raw physics outputs (traces, WASM
internals) can pass cleanly while still being wrong about the *display*
convention — the thing that actually needs to be checked is what ends up on
screen, against what the UI's other elements (sliders, markers, other
overlays) already agree that scale means. This is exactly why the
in-browser visual pass earlier in this session (screenshots, ring
shrink/grow behavior) wasn't redundant with the native numeric validation —
and, this time, still wasn't enough on its own until prompted to actually
compare the two panels against each other rather than each looking
individually plausible.

This rescale is a **weak-field/small-deflection result specifically — not
valid near a black hole's strong-field deflections** — so the distance
slider and the whole background-field panel are weak-field-only: both are
hidden (not just inert) in Schwarzschild mode, and `render()` forces the
rescale ratio to an explicit no-op (`D_ls_mpc = WEAK_D_LS_MPC`) there
regardless of any leftover slider state, so switching modes can't leave a
stale, physically-invalid rescale silently in effect.

The **source-plane panel is not itself rescaled** — every source (primary or
field) is drawn there at its own configured `(cx,cy)` directly, since that
panel shows the intrinsic (unlensed) scene, not a projection, and this
composer's flat, non-cosmological simplification doesn't model
distance-dependent angular size either (consistent with the rest of it, see
the info panel's own disclosure). Field members are randomly generated
(`generateField()`): scattered within ~90% of the current source-position
limit, small (`Re` 0.015-0.065 Mpc — deliberately smaller than the typical
primary-source default so the field reads as background objects, not
foreground duplicates), varied Sersic index/ellipticity/PA, a random
relative brightness weight (so the field isn't uniformly bright), and a
distance uniformly drawn from the configured near/far range. Regenerating is
manual (button), not automatic on every slider nudge — reshuffling the whole
field's positions mid-drag would be visually chaotic, so count/range
sliders only take effect on the next explicit regenerate.

Performance note, not yet optimized: `compositeOnBeta`/`compositeDirect`
loop over every pixel for every source (primary + field), so cost scales
with source count — at N=320 and a few dozen field members this can make
dragging the primary source feel less smooth than with the field off. Not
capped architecturally (the count slider goes to 80), just disclosed here;
lowering the count or resolution restores smoothness.

## Schwarzschild mode: two bugs, both found by "this looks wrong," neither fixable by more resolution

Reported directly ("les images sont pas spécialement bonnes et les
critiques/caustiques très étranges... je sais pas si c'est un souci de
résolution"): the default Schwarzschild scene showed a legitimate outer
Einstein ring, but also a dense little cluster of small, jagged, oddly-
shaped curves right near the center — not a resolution artifact, two actual
bugs, one in a shared core-library file.

**Bug 1 — photon-sphere critical-curve noise, misclassified as real curves.**
Diagnosed with a native sweep (default on-axis scene, N=160/320/480):

```
N=160: 5 tangential segments, 4 radial   — one real (368 pts, r=11.52 r_s), rest 3-96 pts, r=2.16-3.04 r_s
N=320: 11 tangential, 11 radial          — one real (736 pts, r=11.52 r_s), rest 4-192 pts, r=2.41-2.70 r_s
N=480: 11 tangential, 10 radial          — one real (1104 pts, r=11.52 r_s), rest 4-296 pts, r=2.40-2.66 r_s
```

One genuine, resolution-*stable* ring at ~11.52 r_s (barely moves at all
across a 3x resolution range — the signature of a real, well-resolved
feature). Everything else clusters tightly around `b_crit = (3√3/2) r_s ≈
2.598 r_s`, the photon sphere's critical impact parameter, and *doesn't
converge* as N increases — more fragments at N=320 than N=160, not fewer.
That's the tell that this isn't under-resolution: `alpha_hat` diverges
logarithmically as `b → b_crit`, so the true critical-curve structure there
is infinitely many, exponentially-closer relativistic images (photons
winding around the photon sphere increasingly many times before escaping) —
no finite pixel grid resolves that as clean separate curves; a
finite-difference sample of `inv_mu` in that region is just noise riding on
top of a genuine mathematical singularity. **Made worse by
`finalize_grid_result`'s classifier**: it sorts all found segments by mean
radius and blindly splits them in half by *count* into "radial" vs.
"tangential" (`crit_tan`/`crit_rad` in `SceneTrace.hpp`) — a heuristic that's
fine for a simple weak-field scene (one or two real curves) but, faced with
~20 segments where only one is real, mislabels most of the photon-sphere
noise as if it were legitimate radial/tangential curve fragments, drawing it
all as clutter.

**Fixed by excluding the known-singular region from the search, not by
filtering results after the fact.** `find_critical_curve()`
(`raytrace/CriticalCurves.hpp`, shared core-library code, used elsewhere in
the codebase) gained an optional `valid` mask parameter — an edge is only
searched if both endpoints are valid; empty (the default) is byte-for-byte
the previous behavior for every other caller. `finalize_grid_result()`
(`scene/SceneTrace.hpp`) gained a `mask_radius` parameter (default 0, no
masking — every weak-field call site is unaffected); `mask_radius > 0`
excludes samples within that image-plane radius from the search.
`finalize_schwarzschild_grid` computes `b_crit` (already known analytically
elsewhere in this same file, for the capture pre-check) and passes `1.35 ×
b_crit` — enough headroom above the capture check's own 0.95x margin to
swallow every spurious fragment, confirmed by the same native sweep: **1
tangential segment, 0 radial, at every N tested**, `r_mean` stable to <0.02%
across N=160→480, mass tested from 4×10⁶ to 20×10⁶ M☉ (scale-invariant in
`r_s` units, as it must be — `b_crit` is always exactly `2.598 r_s`
regardless of mass).

**Bug 2, found while fixing bug 1 — the BH offset sliders did nothing
sane.** `trace_schwarzschild_chunk` built the BH's offset `center` as
`-x_mpc * u.Mpc` — despite this function's own doc comment stating
distances here are in units of the BH's own `r_s`, "for reasons see
`SceneDescription.hpp`" (which says the same thing). `r_s` for these masses
is of order `1e-13` Mpc, so *any* nonzero offset threw the black hole many
orders of magnitude outside any physically sane field of view — confirmed
directly: tracing with the offset slider at a very ordinary value (5, i.e.
"5 r_s") found **zero** critical-curve segments and the single
strongest-deflection pixel sampled was a flat FD-noise value at the frame
corner — the BH was nowhere near the visible ±20 r_s frame at all. Fixed by
computing `r_s` first (from a temporary, position-independent BH — `r_s`
only depends on mass) and building the real, offset `center` from `x_mpc *
rs` instead of `x_mpc * u.Mpc`. The mask from bug 1 also has to track this
offset (it was written assuming the BH sits at the image-plane origin) —
`finalize_schwarzschild_grid` now shifts `img_x`/`img_y` into BH-centered
coordinates before masking/critical-curve extraction, then shifts the
results (`img_x`/`img_y` and both `crit_tan_*`/`crit_rad_*`) back to world
coordinates before returning; `beta1`/`beta2`/`caust_tan_*`/`caust_rad_*` are
untouched (source-plane quantities, not image-plane-offset-relative).
Re-verified natively: offset slider at 5 now produces a ring centered at
exactly `(5.0, 0.0) r_s`, and in-browser the ring visibly shifts off-center
with the slider, plus (for a source that's no longer perfectly hidden behind
the BH's own axis once it's offset) the expected two-image pattern — a
bright primary and a fainter secondary image on the ring, one on each side
of the now off-center lens.

Both were confirmed visually end-to-end (headless Firefox) after the native
checks, not just left at "the numbers look right": default scene now shows
one clean ring; offsetting the BH visibly moves it and produces the correct
two-image pattern; a 5x heavier BH still shows one clean ring at the same
`r_s`-relative radius; no JS console errors in any of it. `ctest` (all 5
targets, including `test_scene`) passes throughout.

### Parallelism: a Worker POOL with a work-stealing queue, not WASM threads

This runs a **pool of independent Workers** (`live.js`'s `pool`, sized
`min(navigator.hardwareConcurrency, 16)`), each with its own WASM module
instance and no shared memory. Row cost is NOT uniform (a row crossing near
a lens center needs the expensive fine-tolerance window), so the grid is
split into `POOL_SIZE * CHUNKS_PER_WORKER` (10) small chunks and handed out
as a **work queue** — each worker gets the next unclaimed chunk as soon as
it finishes its last one (`dispatchNextChunk()` in `live.js`), rather than a
fixed equal-row band per worker; a worker that lands only cheap rows just
processes more of them. Once every chunk is back, one pool worker runs the
fast finalize pass on the assembled grid.

**Real WASM threading was built and measured, twice, with two different
wrong conclusions along the way before landing on an honest one — worth
reading in full before re-attempting this.** Real WASM multithreading
(`-pthread`, `SharedArrayBuffer`) normally needs
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` response headers,
which GitHub Pages' static file serving cannot set — but a service-worker
header-injection trick (`coi-serviceworker.js`, present in this directory)
works around that even here, confirmed empirically in Firefox served exactly
like GitHub Pages would (plain `python -m http.server`, zero custom
headers): `window.crossOriginIsolated` becomes `true` after one automatic
reload the first time the worker activates in a browser, and real
`std::thread`s inside a `-pthread` WASM build (`excalibur_scene_threaded.
wasm`, built from the SAME `wasm/scene_bindings.cpp`, gated by
`add_executable(excalibur_scene_threaded ...)` in `wasm/CMakeLists.txt`)
then work and scale well in isolation (14 threads: 5.5x on a full N=256
grid, still ~4x even on a tiny N=16 one).

1. **First comparison: threaded looked ~10x slower.** Wrong — an embind
   `value_object` requires every registered field to be present, and adding
   `nthreads` to `WeakFieldSceneSpec`/`SchwarzschildSceneSpec` without also
   updating `live-worker.js`'s (non-threaded) spec builder to send it made
   *every* pool chunk throw `Missing field: "nthreads"`. Silently, from the
   UI's point of view: the pool's error handler resets `currentRequest` to
   `null` and hides the loading overlay, and `updateLiveStatus()` falls back
   to showing the *target* resolution whenever nothing is in flight —
   identical display whether a trace genuinely finished or silently died on
   its first chunk. Caught by checking `SCENE.N` directly instead of
   trusting the status text; see `live-worker.js`'s `toWeakFieldSpec`/
   `toSchwarzschildSpec` for the one-line fix (`nthreads: 0`).
2. **Second comparison, after that fix: threaded was a real but more modest
   ~40% slower**, climbing the full resolution ladder to N=256 in ~8.1s vs.
   ~5.7s pooled — attributed at the time to a `-pthread` build's shared,
   atomics-backed linear memory taxing every memory access, not just
   synchronization points. **Also wrong, and directly disproved**: the
   threaded *build* at `nthreads=1` (no real threading at all — same serial
   code path `nthreads=0` takes) measured *faster* on an identical N=256
   trace than the plain non-threaded build (12.6s vs. 14.2s) — so pthread
   compilation itself is not a tax here. The real, larger effect turned out
   to be a one-time **~1s pthread-pool-spawn cost paid once per fresh page
   load** (`PTHREAD_POOL_SIZE` pre-spawns real Workers) that a "restart the
   ladder immediately after navigating" benchmark pays in full, but a
   visitor who's already interacting with a loaded page wouldn't pay again.
   (A `-sALLOW_MEMORY_GROWTH` + `-pthread` combination Emscripten's own
   linker warns is slow was also swapped for a fixed `-sINITIAL_MEMORY` in
   `wasm/CMakeLists.txt` on the same suspicion; didn't measurably help on
   its own, kept anyway since it's a harmless, slightly more predictable
   config.)
3. **Honest bottom line**, controlling for both bugs above and for warm vs.
   cold starts: threaded and pooled are roughly **comparable** for this
   workload — each won some in-page-timed back-to-back runs and lost others,
   well within this machine's own run-to-run noise (the pool architecture's
   *own* repeat-run timings varied ~35% run to run here just from ordinary
   system noise). Not the large, clear win "real threading" suggests, and
   not a clear loss either. Given that, and that threading adds real,
   ongoing complexity for at best a wash — a service-worker dependency, an
   extra automatic reload on a visitor's first-ever page load, a second
   build artifact to keep in sync, cross-browser behavior checked in Firefox
   only — it stays unactivated (`index.html` does not load
   `coi-serviceworker.js`). But **"the pool wins because pthreads carry an
   inherent memory-access tax" is not an accurate reason and shouldn't be
   repeated** without new measurements; the real, load-bearing finding here
   is the one-time pool-spawn cost, not a per-access one.

The threaded build/`live-worker-threaded.js`/`coi-serviceworker.js` are kept
in this directory (unwired) in case a persistent (not spawn-per-call)
thread pool, or a future workload profile, changes this calculus — see the
top of the "Worker POOL" section in `live.js` for the same notes inline.

Combined with:
- the impact-parameter culling in `trace_weak_field_chunk`/
  `trace_schwarzschild_chunk` (skip the fine window for rays that don't pass
  near any lens — only genuinely effective once the FOV widening made the
  window a *minority* of the visible frame, not comparable to it);
- **`cull_radius`, currently `0.20×window_half`** (weak-field only —
  Schwarzschild's stayed at 2x, untouched, since that regime wasn't
  independently validated and wasn't the ask). History: originally a blind
  `2×window_half` margin (inherited from the window's own size, not the
  lens's actual physical scale); first re-tuned to `0.15x` after sweeping
  2x/1.5x/1x/0.5x/0.15x against a centered NFW's ring radius, a 3-lens mixed
  scene's critical/caustic segment counts, and the raw beta values of the
  dozen pixels closest to a lens center (the actual "spurious speckled blob"
  failure mode windowing exists to prevent) for both a typical-mass NFW and
  a worst-case stress scene (concentration=15, low mass, lens centered
  exactly on a grid vertex) — every check came back bit-identical all the
  way down to 0.15x.
  **Re-swept a second time after the FOV was zoomed in** (`WEAK_HALF_FOV_MPC`
  4.0 → 1.5 Mpc, on request, to match the precomputed gallery's own
  framing): a narrower FOV at the same N packs pixels more densely, so a
  fixed-radius cull disk now covers a bigger *fraction* of the grid, and the
  windowed/unwindowed cost balance 0.15x was tuned for had shifted. Result
  was NOT the same clean "smaller is safe" story as the first sweep: below
  0.15x, the typical scene keeps getting faster (up to ~1.7x at 0.01x) but
  the worst-case stress scene gets MEANINGFULLY SLOWER (down to ~0.46x, more
  than 2x slower) — near a genuinely sharp, small-scale cusp, denying the
  coarse stepper the fine window it needs makes it burn real time on
  rejected/retried steps instead. Above 0.15x the two scenes' optima are on
  *opposite* sides (typical keeps improving to ~1.8x around 0.25-0.30x;
  stress degrades monotonically past 0.15x) — **0.20x** is the one value
  where the typical scene gets a real ~15-20% win while the stress scene
  stays within run-to-run noise of unchanged (~0.98x), so that's what
  shipped. Ring radius, segment counts, and closest-pixel beta values
  (deviation ~1e-12 Mpc, utterly negligible) stayed identical at every
  fraction tested in both directions — this is a pure speed/regime trade,
  not a correctness one. See `excalibur/scene/SceneTrace.hpp`'s comment at
  this constant for the full sweep notes;
- an **analytic photon-capture pre-check** for Schwarzschild specifically
  (`b_crit = (3√3/2) r_s`, the textbook critical impact parameter for null-
  geodesic capture): a ray with impact parameter below this is *guaranteed*
  captured, so it's flagged directly with zero integration, instead of
  paying for a failed fine-window attempt (up to `fine_cfg.max_steps`)
  *and then* a failed coarse-only fallback (up to `coarse_cfg.max_steps`)
  before landing on the same "no deflection" result this shortcut gives for
  free —

measured in-browser (Firefox, headless, 14-core machine), plus the FOV/N
change for Schwarzschild above:

| scene | single worker | pool (static bands) | + work-stealing/wider FOV | + tuning | total speedup |
|---|---|---|---|---|---|
| weak-field, 1 NFW lens, N=192 | 17.1s | 4.5s | 2.0s | **1.1s** (cull_radius retune) | **15.4x** |
| Schwarzschild, N=192, fov=20 r_s | ~18.5s (N=128, fov=10) | 3.6s | 1.0s | **0.72s** (analytic capture, *despite* higher N + wider FOV) | **~26x** |

Schwarzschild got faster even though N went up (128→192) and the FOV doubled
again (10→20 r_s) — a wider FOV shrinks the *fraction* of the frame within
`cull_radius`/the capture disk, so both optimizations cover proportionally
more of the grid, more than offsetting the extra pixels from the higher N.

See `excalibur/scene/SceneTrace.hpp`'s `trace_weak_field_chunk`/
`trace_schwarzschild_chunk`/`finalize_*` split in `excalibur-cpp` for how the
chunked tracing is implemented C++-side (verified bit-exact against the
non-chunked one-shot path before this was wired up to WASM).

### Later tuning: redundant ray generation, and a rejected RK4 experiment

Two more `scene/`-layer-only levers were investigated after the table above
(no `excalibur-cpp` header outside `scene/` was touched for either):

- **Shipped — eliminated redundant per-chunk ray generation.**
  `trace_weak_field_chunk`/`trace_schwarzschild_chunk` used to call
  `generate_camera_rays(cam, metric)` — which always builds the FULL N×N
  grid — fresh on *every* chunk call, discarding all but that chunk's own
  small slice. With `POOL_SIZE * CHUNKS_PER_WORKER` (up to 160) chunks per
  trace, that repeated the whole grid's worth of per-pixel camera/metric
  setup on the order of a hundred times over per trace. Replaced with
  `detail::generate_camera_rays_range(cam, metric, idx_start, idx_end)`,
  which builds only the requested slice (same per-pixel math, reusing
  `Camera.hpp`'s own `camera_pixel_direction()`/`make_null_wavevector()`
  building blocks unchanged). Measured (native, single-threaded, N=192,
  160 simulated chunks): a modest but real **~3% of total trace time**
  (~168ms out of ~5.6s) — ray generation itself is cheap next to the actual
  geodesic integration, so eliminating its redundancy doesn't move the
  needle as much as the cull_radius/analytic-capture work above, but it's
  free (zero accuracy cost, bit-exact against the original) and its benefit
  scales with chunk count, so it's worth more at finer pool granularity than
  tested here.
- **Investigated and rejected — fixed-step RK4 for the "coarse" (far-field,
  low-curvature) integration stages.** Every ray's dominant cost is either a
  single unwindowed coarse pass (rays far from any lens) or two coarse
  "bookend" segments straddling a fine window (rays near a lens/cusp) — both
  currently run on adaptive `DormandPrince45`, even though the physics there
  is close to a straight line. Swapping those coarse-only segments to
  fixed-step `RK4` (already in `excalibur/integrate/Integrators.hpp`, no
  library change needed) at 4x the seed step size gave a genuine
  **~30–40% full-grid speedup** (native, N=192: 5.57s→4.32s centered NFW,
  5.79s→4.07s worst-case-stress NFW) with sub-pixel error on both of those
  scenes — but **broke badly on a `PointMass` lens**: the shipped
  `test_scene.cpp` check (traced Einstein-ring radius vs. the closed-form
  analytic value) went from passing to a **30% error** (0.235 vs. 0.339 Mpc).
  Root cause: a point mass's deflection falls off as a bare `1/b` with no
  core-radius softening, so rays near the eventual critical curve still see
  non-negligible curvature far outside the fine window — exactly where the
  fixed large RK4 step can't adapt down — while NFW's extended, softened
  profile does not have this problem at the same impact parameters. Since
  `PointMass` is one of the six lens types in the actual composer palette
  (the *first* one, in fact), this isn't an edge case — it's reverted
  entirely, not shipped. Left here as a documented dead end so it isn't
  re-attempted the same way: a correct version of this idea would need
  either a genuinely adaptive-but-cheaper coarse stepper, or a
  curvature-aware criterion for when the fixed-step shortcut is safe to
  take — both are real integration-scheme design work, not a config tweak,
  so they belong in `excalibur/integrate/` (core library), not here. See
  "Further acceleration: ideas not pursued" below.

### Further acceleration: ideas not pursued here

These would require changes to `excalibur-cpp` outside `scene/` — i.e.
actual core-library work, not a composer-side config/tuning change — so
they were deliberately not implemented, only identified:

- **A correct version of the rejected RK4-coarse idea above**: either a
  genuinely adaptive low-order stepper cheaper than DP45's 6-stage embedded
  pair, or a curvature-aware criterion that falls back to full DP45
  whenever a ray's impact parameter is small enough that the weak-deflection
  approximation the fixed step relies on stops holding (a `PointMass`-safe
  version of the idea above). New integration-scheme design, belongs next to
  `RK4`/`DormandPrince45`/`DormandPrince853` in
  `excalibur/integrate/Integrators.hpp`.
- **A GPU compute-shader backend** (WebGPU from the browser) for the RHS
  evaluation — the photon grid is embarrassingly parallel per-pixel, and
  the existing native benchmark (`docs/GPU_RESULTS.md`) shows ~30x from
  64-way CPU parallelism alone; real GPU dispatch could go further still.
  Needs the Christoffel/RHS evaluation portable to a compute-shader
  abstraction — a new `exec::` backend alongside the existing CUDA/Kokkos
  ones, squarely core-library scope.
- **True WASM threading** (`-pthread` + `SharedArrayBuffer`) instead of
  today's pool-of-independent-module-instances: would let one shared WASM
  module serve all threads (no per-worker module instantiation, no
  postMessage copy for chunk results). This one is *not* really a library
  change — the library's `exec::` backends already support this pattern
  natively — it's blocked on hosting: it needs
  `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` response
  headers, which plain GitHub Pages static serving cannot set. (A
  Service-Worker-based COOP/COEP polyfill exists as a workaround but is
  fragile and is a site/hosting-layer change, not a library one — flagged
  for awareness, not proposed.)
- **A new custom Butcher-tableau embedded pair** (via the library's
  existing `AbstractRK` framework) tuned specifically for this system's
  null-geodesic RHS and the curvature scales this composer actually uses —
  speculative, would need real numerical-methods derivation/validation, not
  a quick win.
- **Potential-grid/interpolation-based approximate lensing**: precompute
  the deflection field on a coarse grid once per scene edit, then
  bilinear/bicubic-interpolate per output pixel instead of integrating every
  photon from scratch. Would eliminate most of the redundant physics, but
  it's a fundamentally different algorithm (field interpolation instead of
  ray tracing) with its own accuracy/artifact profile near cusps — big
  enough a change in kind that it's a new library capability, not a knob,
  and moves away from this project's "genuinely ray-traced, not
  precomputed" premise.
- **`MixedPrecisionSystem`** (FP32 RHS evaluation wrapped around the FP64
  state) already exists in the core library, so it's technically usable
  without a library change — but untested here: WASM's `f32` SIMD path
  doesn't have the same well-established win native SIMD does, and the
  RK4 experiment above is a concrete reminder that a precision/scheme
  change needs the same per-lens-type validation before shipping, not just
  a "did it get faster" check. Not attempted this session for lack of time,
  not because it's out of scope.
