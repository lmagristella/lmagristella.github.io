---
title: "Interactive gravitational lensing applet"
date: 2026-05-29
categories:
  - random-science
tags:
  - gravitational lensing
  - applet
  - education
  - ray tracing
---

# Gravitational lensing (DOWNLOAD LINK AT THE BOTTOM OF THE POST!)

Gravitational lensing is an idea that is easy to describe but might be hard to visualize if you're not already familiar with some context. If you put enough mass between you and a distant galaxy, spacetime curves just enough that the galaxy's light gets smeared on our sky into arcs, multiple images in extreme cases, and even rings. This little app lets you grab that galaxy and drag it around to watch it happen.

## What you're looking at

Two panels, side by side:

- **Left, the source plane.** Where the galaxy *actually* is. A glowing blob you can move with the mouse (or the sliders).
- **Right, the lensed sky.** What a telescope on Earth would *see* after a massive dark matter halo (at redshift 1, a few billion lightyears away from us) bends the light on its way to us (from redshift 2, a few more billions lightyears away).

Drag the source toward the center and watch your galaxy get split into arcs, break into multiple images and, in some cases, form a perfect circle: an Einstein ring. Every pixel of the resulting images come from photons traced through the curved spacetime around an NFW halo using EXCALIBUR, then mapped back to the sky.

## The knobs

Sliders reshape the background galaxy (position, size, ellipticity, Sérsic index, brightness). Checkboxes to show some physical quantities:

- **r_s** : the halo's scale radius,
- **θ_E** : the Einstein radius,
- **critical curve** : the curve where magnification blows up (the bright arcs live here),
- **caustic curve** : the critical curve's projection in the source plane: have your galaxy cross it, and new images will appear or vanish.

## The fun part: five halos, same mass

The buttons above the checkboxes allows you to switch between five lens geometries, all have the same mass, just shaped and oriented differently:

| Profile | What it is | What we can see |
|---|---|---|
| **Spherical** | a round halo | an Einstein ring |
| **Elliptical** | a rugby ball lying sideways |a cross, caustic opens into a 4-cusp shape called an **astroid** |
| **Inclined** | the same ball, tilted 45° from the line of sight | the ellipse relaxes toward a circle |
| **Cigar parallel to the line of sight** | the same ball, pointed at our eye | looks round on the sky but lenses stronger than its spherical cousin|
| **Triaxial** | three unequal axes, random tilt | the messy, most realistic case |

The most interesting case in my opinion is the cigar: it projects to a perfect circle, identical in symmetry to the sphere yet its Einstein ring is noticeably bigger.

## Why bother doing this ? 

In reality, lenses are lumpy, often not simply triaxial, and randomly oriented. Playing with these idealized cases helps building some basic intuition to visualize the phenomenon! (and honestly, it's just fun to bend light with a computer mouse, plus it looks cool!)

Thanks for reading and have fun!
Laurent MAGRI-STELLA

## Access

<a href="/assets/excalibur_lensing_webapp/" class="btn btn--primary btn--large" target="_blank">
  ▶ Ouvrir l'applet interactive
</a>

**Update:** there's now a second, live version of this tool — instead of picking between precomputed lens shapes, you compose your own scene (any mix of lenses, or a Schwarzschild black hole) and EXCALIBUR ray-traces it *in your browser*, on the spot, via WebAssembly. See [the live composer post]({% post_url 2026-08-15-live-gravitational-lensing-composer %}) for details.
