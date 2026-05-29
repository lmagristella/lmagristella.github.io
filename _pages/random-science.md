---
title: "Random science"
permalink: /random-science/
layout: single
author_profile: true
---

Welcome to the random science section, where I will post little results from either my research or some other things I might have spent a sleepless night on. Subjects can range from astrophysics and cosmology to just whatever crosses my mind at a given point in time! 

## Posts

{% assign random_science_posts = site.posts | where_exp: "post", "post.categories contains 'random-science'" %}

{% if random_science_posts.size > 0 %}
<ul>
  {% for post in random_science_posts %}
    <li>
      <a href="{{ post.url | relative_url }}">{{ post.title }}</a>
      <small>— {{ post.date | date: "%d/%m/%Y" }}</small>
    </li>
  {% endfor %}
</ul>
{% else %}
<p>Aucun billet pour le moment.</p>
{% endif %}
