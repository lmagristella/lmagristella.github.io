---
title: "Live gravitational lensing scene composer"
date: 2026-08-15
categories:
  - random-science
tags:
  - gravitational lensing
  - applet
  - education
  - ray tracing
---

# A new lensing tool that works in real time

The [original lensing applet]({% post_url 2026-05-29-interactive-gravitational-lensing-applet %}) let you drag a galaxy around behind a fixed selection of precomputed lens models and shape: NFW halo geometries, a void, a Schwarzschild black hole, a binary black hole system. It's cool to mess with, but the systems were always one of eight baked-in options: every deflection field had been ray-traced ahead of time and saved to disk.

This new app is different: you build the lens yourself, add point masses, isothermal spheres, NFW halos, triaxial halos, voids, or switch entirely to a Schwarzschild black hole, and EXCALIBUR (the same C++ relativistic ray-tracer behind the original applet) traces the whole deflection field on the spot, compiled to WebAssembly. Every scene you compose gets its own photons launched and integrated through curved spacetime on your machine.

## How does it work?

Drag a mass slider, add a lens, switch to the black hole mode, and the image starts being built. The very first frame you see is deliberately low-resolution (computed almost instantly), and it keeps sharpening on its own in the background through a whole ladder of intermediate resolutions, each pass replacing what's on screen the moment it's ready.


## Two different physics regimes

**Multi-lens (weak field):** any combination of the six lens profiles, added additively, each with its own position including the line of sight, so you can push a lens toward or away from the source and watch the response. 

**Black hole (Schwarzschild):** exact strong-field geodesics around a single black hole, including real photon-sphere bending and a captured-photon shadow. 

## Try it

<a href="/assets/excalibur_lensing_live/" class="btn btn--primary btn--large" target="_blank">
  ▶ Open the app
</a>

The [original lensing gallery]({% post_url 2026-05-29-interactive-gravitational-lensing-applet %}) is still there and unchanged if you want the five halo shape comparison this new sandbox doesn't try to replace.

Laurent MAGRI-STELLA
