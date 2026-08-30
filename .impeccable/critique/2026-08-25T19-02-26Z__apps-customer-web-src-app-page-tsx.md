---
target: homepage hero screenshot
total_score: 22
max_score: 32
na_heuristics: 1,9
p0_count: 0
p1_count: 4
timestamp: 2026-08-25T19-02-26Z
slug: apps-customer-web-src-app-page-tsx
---
## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of System Status | n/a | Static marketing hero; catalog state is outside this scope. |
| 2 | Match System / Real World | 3 | Travel language is natural, but first-time buyers still have to infer what an eSIM is. |
| 3 | User Control and Freedom | 3 | Clear routes to plans, education, compatibility, and sign-in; no destination-first action. |
| 4 | Consistency and Standards | 3 | Cohesive visual system, but headline scale and typography implementation drift. |
| 5 | Error Prevention | 2 | Compatibility exists but is separated from the purchase decision; “Keep your number” can be overread. |
| 6 | Recognition Rather Than Recall | 3 | Main actions are visible, while destination, price, and payment details are deferred below the fold. |
| 7 | Flexibility and Efficiency | 2 | High-intent buyers cannot start with a destination in the hero. |
| 8 | Aesthetic and Minimalist Design | 3 | Refined and calm, but the five-line headline consumes more attention than its information value earns. |
| 9 | Error Recovery | n/a | No error interaction exists in the scoped hero. |
| 10 | Help and Documentation | 3 | How it works and compatibility are discoverable, but reassurance is deferred. |
| **Total** | | **22/32** | **Acceptable; strong craft, significant conversion work remains.** |

## Design Specificity Verdict

The ocean/teal palette, airport imagery, NPR language, and local-support message feel authored for Visa Compass. However, the headline and hero structure remain category-interchangeable: the same composition could sell roaming, airport Wi-Fi, a carrier, or a travel app. The product category and Nepal-local advantage live in subordinate copy rather than owning the first impression.

The deterministic detector returned zero findings for `page.tsx`. Browser evidence found issues the mechanical scan cannot infer: CTA contrast is 4.42:1, the desktop heading wraps to five lines and makes the hero taller than the viewport, header targets fall below the repository’s 44px standard, reduced-motion rules remove all useful feedback, and Geist is loaded while Inter is explicitly used.

## Overall Impression

This looks trustworthy and premium, but it behaves more like a travel campaign than a high-converting eSIM storefront. The single biggest opportunity is to turn the hero from “inspiration before shopping” into “confidence plus the first buying action.”

## What’s Working

- The visual world is coherent: deep ocean, teal, restrained gold, and real travel context feel calm and credible.
- CTA hierarchy is clear, with strong 50px hero targets and descriptive labels.
- NPR pricing, pre-departure preparation, and local support communicate real differentiation without fabricated claims.
- The LCP image implementation is strong: optimized assets, `priority`, `fill`, responsive `sizes`, and meaningful alt text.

## Priority Issues

### [P1] The value proposition is memorable but not specific

“Your journey shouldn’t lose signal” foregrounds anxiety and does not identify the product. Visitors must read the paragraph to learn that Visa Compass sells travel eSIMs in NPR.

**Fix:** Make the category and local advantage explicit above the fold. Recommended structure: “Arrive connected, wherever you land.” followed by “Travel eSIMs for Nepali travellers—priced in NPR, prepared before departure, and backed by local support.”

**Suggested command:** `$impeccable clarify`

### [P1] The hero does not begin the buying task

The primary CTA only scrolls. Destination, price context, and plan selection remain below a nearly full-viewport hero. Purchase-ready users cannot immediately answer whether their destination is covered.

**Fix:** Add a compact destination finder in the hero, or at minimum rename the CTA to “Choose your destination” and reveal the start of the destination section above the fold.

**Suggested command:** `$impeccable shape`

### [P1] Trust evidence is too generic and visually subordinate

The proof row is small and “Keep your number” can be overinterpreted. It omits stronger verified purchase reassurance such as NPR pricing, Khalti, compatibility before payment, private activation details, and local support.

**Fix:** Replace the proof row with three precise facts: “Prices shown in NPR,” “Pay securely via Khalti,” and “Check compatibility before payment.”

**Suggested command:** `$impeccable clarify`

### [P1] Primary CTA contrast narrowly misses WCAG AA

Browser-computed contrast is 4.42:1 for 16px text on the teal button; normal text requires 4.5:1. The brighter hover color reduces contrast further.

**Fix:** Darken the teal surface or use deep-ocean text on a lighter signal-teal button, then verify rest, hover, active, and focus states.

**Suggested command:** `$impeccable colorize`

### [P2] The oversized heading and image consume too much selling space

At 1919×975 the heading is five lines and about 463px tall; the hero extends below the viewport. The image is emotionally effective but the phone interaction is not explanatory, and the overlay repeats adjacent copy.

**Fix:** Shorten the headline to two or three lines, reduce its desktop measure/scale imbalance, and use the image overlay for truthful process information rather than repeated reassurance.

**Suggested command:** `$impeccable layout`

## Persona Red Flags

- **Jordan, first-time buyer:** Understands travel and connection, but not what an eSIM is, whether a physical SIM stays usable, or why compatibility matters before purchase.
- **Casey, distracted mobile traveller:** Must move past the stacked hero image before reaching destination selection; slow catalog/API conditions increase abandonment risk even though mobile CTA sizing is good.
- **Riley, skeptical buyer:** Sees attractive imagery and generic proof but no immediate Khalti/payment, compatibility, privacy, or provisioning reassurance.
- **Price-sensitive Nepali traveller:** Notices NPR, but receives no price anchor or direct destination availability above the fold.

## Cognitive Load and Emotional Journey

Cognitive load is moderate. The screen is visually simple, but users process an abstract five-line statement, a large photograph, an overlay, two actions, and three tiny proof points before receiving little purchase-decision information.

Current emotional sequence: travel anxiety → aspirational image → general reassurance → scroll to start shopping.

Better sequence: departure anticipation → immediate eSIM recognition → local payment confidence → compatibility reassurance → destination action.

## Minor Observations

- Desktop nav links are 33px high and the theme toggle is 38×38, below the project’s stated 44px target.
- Global reduced-motion rules force all motion to 0.01ms instead of preserving useful state feedback intentionally.
- Geist is imported and attached as a variable class, but body and hero typography explicitly use Inter.
- Hero text contrast, image optimization, semantic main/H1 structure, skip link, and mobile horizontal overflow are all solid.
- The image alt text asserts “Nepali traveller,” which may not be visually verifiable from the image alone.

## Questions to Consider

1. Should the hero prioritize immediate plan purchase, balanced education and purchase, or brand storytelling first?
2. Should the tone move from loss avoidance toward positive arrival confidence?
3. Should the next pass address the top three conversion blockers only, or the full hero/header system including accessibility and motion?
