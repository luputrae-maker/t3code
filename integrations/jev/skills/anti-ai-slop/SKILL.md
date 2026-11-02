---
name: anti-ai-slop
title: Anti AI slop
related: impeccable
description: Spot and remove the tells of generic AI-made design and writing. Runs a review pass after every UI edit.
triggers: ui, ux, design, page, screen, landing, component, css, style, layout, frontend, website, app, button, hero, dashboard, copy, onboarding
default: on
review: on
---
# Anti AI slop

The goal is work that looks like a careful person made it for this product. If a choice is the first thing every generator reaches for, question it.

## Visual tells to avoid
- Purple, violet or blue-to-pink gradients, especially on heroes, buttons and text. Use flat color. If depth is needed, use a soft shadow or a frosted surface.
- Neon glow: colored `box-shadow: 0 0 20px …`, glowing text, glowing borders.
- Emoji as bullets or icons in headings and feature lists. Use real icons sparingly, or nothing.
- All-caps labels and `text-transform: uppercase`. Use sentence case everywhere, including buttons and section labels.
- The centered hero cliché: huge centered headline, gradient word, two pill buttons, a fake "trusted by" row.
- Filler cards: three or six identical feature cards with an icon, a two-word title and a vague sentence.
- Random spacing like 13px, 22px, 37px. Stay on the spacing scale (4, 8, 12, 16, 24, 32, 48, 64).
- Glassmorphism stacked on everything, rainbow borders, sparkles, "AI" badges, oversized rounded corners on every element.
- Numbered annotation bubbles. Put an annotation right next to what it describes.

## Writing tells to avoid
- "Unlock the power of", "revolutionize", "seamless", "cutting-edge", "elevate", "supercharge", "game-changer", "next-level", "harness", "empower", "in today's fast-paced world", "delve", "leverage", "robust" in marketing copy.
- Triplets for rhythm ("fast, simple, and powerful"), rhetorical questions as headlines, exclamation marks.
- Lorem ipsum, "John Doe", "Acme", "Feature one". Use believable, specific content.
- Em-dash-heavy sentences and "It's not just X, it's Y".

## Instead
- One accent color at most, used for the primary action and focus.
- Left-aligned, scannable layouts with clear hierarchy from size and weight, not color.
- Short, plain copy that says what the thing does.

## Review
After editing a UI file, Superbuilder scans it for these tells. When something is flagged, fix it with a small edit unless it is clearly intentional, and say why if you keep it.
