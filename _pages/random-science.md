---
title: "Random science"
permalink: /random-science/
layout: single
author_profile: true
classes: wide science-page
---

<section class="page-panel">
  <span class="section-label">Explorations</span>
  <h2>Side projects, visual intuition, and scientific curiosities</h2>
  <p class="random-intro">
    Smaller, looser stuff that doesn't really fit a formal research summary: interactive toys, quick
    investigations, half-formed ideas I felt like sharing anyway.
  </p>
</section>

{% assign random_science_posts = site.posts | where_exp: "post", "post.categories contains 'random-science'" %}

{% if random_science_posts.size > 0 %}
<ul class="post-list-science">
  {% for post in random_science_posts %}
    <li>
      <strong><a href="{{ post.url | relative_url }}">{{ post.title }}</a></strong>
      <span>Published on {{ post.date | date: "%d/%m/%Y" }}</span>
    </li>
  {% endfor %}
</ul>
{% else %}
<section class="page-panel">
  <p>No posts yet.</p>
</section>
{% endif %}
