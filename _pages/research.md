---
title: "Research"
permalink: /research/
layout: single
classes: wide science-page
---

<section class="research-panel">
	<span class="section-label">Overview</span>
	<h2>Relativistic cosmology with an eye on observables</h2>
	<p class="research-intro">
		My work is in theoretical and numerical cosmology. Over the years I've looked at a few different ways
		relativity shapes what we actually observe: light propagation, weak lensing, peculiar velocities.
		This page gathers the main threads, past and present.
	</p>
</section>

<section class="research-panel">
	<span class="section-label">Current project</span>
	<h2>PhD thesis: EXCALIBUR</h2>
	<p>
		This project picks up where a master's internship left off, right before my PhD started. You can read that
		internship report <a href="/assets/files/rapport_stage_Laurent.pdf">here</a>.
	</p>
	<p>
		These days I'm building <strong>EXCALIBUR</strong> (<em>Exact Calculation of Light Bending Using Relativity</em>),
		which is the main thing I work on. It propagates light rays through cosmological grids using a first-order
		perturbed FLRW metric, with the goal of reconstructing the sky the way an observer would actually see it in a
		simulation.
	</p>
	<p>
		The goal is to quantify how much relativistic effects bias the cosmological quantities we measure. Surveys are
		getting precise enough now that the usual approximations might not hold up.
	</p>
	<ul class="key-points">
		<li>Ray tracing in perturbed FLRW spacetime</li>
		<li>Numerical lightcone construction</li>
		<li>Lensing and relativistic systematics</li>
	</ul>
</section>

<section class="research-panel">
	<span class="section-label">Previous projects</span>
	<h2>Selected research experiences</h2>
	<ul class="compact-list">
		<li>
			<strong>Weak gravitational flexion in cosmological simulations</strong>
			<p>
				Using the Horizon-AGN simulation, I measured second-order "flexion" terms in the weak-lensing regime, to
				see whether these subtler distortions could sharpen our constraints on halo shapes and masses.
				<a href="/assets/files/flexion_report.pdf">Read the internship report</a>.
			</p>
		</li>
		<li>
			<strong>Fisher forecasts for peculiar-velocity surveys</strong>
			<p>
				At CPPM in Marseille, I ported a C++ forecasting code by Cullan Howlett to Python, mainly to make it
				easier to tinker with and share. It reproduced the original results, and hopefully makes life easier
				for whoever uses it next.
			</p>
		</li>
		<li>
			<strong>Light propagation in inhomogeneous spacetimes</strong>
			<p>
				Even earlier, I worked on light propagation in Lemaitre-Tolman-Bondi spacetimes and perturbed FLRW
				geodesics. That project is what got me hooked on building relativistic tools for cases where our usual
				homogeneous intuition stops working.
			</p>
		</li>
	</ul>
</section>
