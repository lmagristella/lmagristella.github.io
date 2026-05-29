---
title: "Random science"
permalink: /random-science/
layout: single
author_profile: true
---

Bienvenue dans ma section **Random Science** — une collection de billets courts autour d'idées, de visualisations, d'outils interactifs et de curiosités scientifiques liées à l'astrophysique, à la cosmologie et à d'autres sujets qui m'intéressent.

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
