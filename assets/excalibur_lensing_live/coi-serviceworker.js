// coi-serviceworker.js -- makes SharedArrayBuffer (and therefore real WASM
// pthreads, see excalibur_scene_threaded.wasm/live-worker-threaded.js)
// available on a static host that cannot set the Cross-Origin-Opener-Policy/
// Cross-Origin-Embedder-Policy response headers SharedArrayBuffer normally
// requires -- GitHub Pages is exactly such a host. Reimplementation of the
// well-known "coi-serviceworker" technique (originally by Guido Zuidhof /
// gzuidhof): once active, this service worker intercepts every fetch in its
// scope and stamps both headers onto the response before the browser
// evaluates cross-origin isolation.
//
// A page loaded BEFORE this worker is controlling anything is never
// isolated (window.crossOriginIsolated stays false) -- there is no way to
// retroactively isolate an already-parsed document. So the registration
// half below, after confirming the worker is active, forces exactly one
// window.location.reload(): that reload IS a fresh navigation the now-active
// worker can intercept, and cross-origin isolation becomes true from that
// point on. This only happens once per browser profile (service worker
// registration persists like a PWA install, until site data is cleared) --
// not on every visit.
//
// live.js checks window.crossOriginIsolated at its own startup and falls
// back to the original (slower, but always-correct) pool-of-independent-
// non-threaded-modules architecture if it's still false there (registration
// failed, service workers unsupported/disabled, ...) -- this file failing
// silently never breaks the composer, it just leaves it un-accelerated.
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", function (event) {
    if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") return;
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 0) return response; // opaque cross-origin response, headers can't be touched
          const newHeaders = new Headers(response.headers);
          newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error("coi-serviceworker fetch failed:", e))
    );
  });
} else {
  (() => {
    if (window.crossOriginIsolated) return; // already isolated, nothing to do
    if (!("serviceWorker" in navigator)) { console.warn("coi-serviceworker: navigator.serviceWorker unavailable"); return; }
    navigator.serviceWorker.register(window.document.currentScript.src).then(
      (registration) => {
        registration.addEventListener("updatefound", () => window.location.reload());
        if (registration.active && !navigator.serviceWorker.controller) window.location.reload();
      },
      (err) => console.warn("coi-serviceworker registration failed:", err)
    );
  })();
}
