---
title: "Journal"
permalink: /journal/
layout: single
author_profile: true
classes: wide science-page
---

<section class="page-panel">
	<span class="section-label">Journal</span>
	<h2>Research journal</h2>
	<p class="page-intro">
		Notes, small tools, side explorations, roughly in the order I did them. It's less polished than the rest
		of the site, and that's kind of the point.
	</p>
</section>

{% if site.posts.size > 0 %}
<ul class="journal-list">
	{% for post in site.posts %}
		<li>
			<span class="journal-date">{{ post.date | date: "%d %B %Y" }}</span>
			{% if post.categories.size > 0 %}
			<span class="journal-tags">
				{% for cat in post.categories %}<span class="cat-badge">{{ cat }}</span>{% endfor %}
			</span>
			{% endif %}
			<h3><a href="{{ post.url | relative_url }}">{{ post.title }}</a></h3>
			{% if post.excerpt %}
			<p>{{ post.excerpt | strip_html | truncatewords: 40 }}</p>
			{% endif %}
		</li>
	{% endfor %}
</ul>
{% else %}
<section class="page-panel">
	<p>No entries yet. Check back soon.</p>
</section>
{% endif %}
