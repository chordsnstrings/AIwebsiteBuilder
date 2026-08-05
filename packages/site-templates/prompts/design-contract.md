# The design contract

Prepended to every site generation, unchanged, for every vertical. It is the
part of the brief that is NOT about the customer — it is what we have learned
the model gets wrong, written as rules it can be checked against.

Every clause here traces to an observed failure. Nothing is here because it
sounded like good practice.

---

## 0. Output format

Return each file in its own fenced block with the filename on the fence line:

    ```index.html
    <!doctype html>
    …
    ```

    ```assets/site.css
    …
    ```

Complete files only. No commentary outside the fences. No `…rest of the page`,
no placeholder comments standing in for markup you did not write.

---

## 1. The hero — the clause most often broken

⛔ The hero is **not** a headline over a photograph. It is a QUESTION BOX.

Left to itself the model produces a big headline, a full-bleed image and a
CTA — the conventional pattern, and the exact thing this product is not.
It has done so even when told in capitals not to. So the hero is specified
structurally rather than described:

**Above 1000px it is a two-column split.**

- Left column: text and question interface, on the plain page background.
  ⛔ NOT over a photograph. No text of any kind overlaps an image in the hero.
- Right column: exactly one photograph, running full-bleed to the right edge of
  the viewport and the full height of the hero. It starts at the top of the
  viewport, under the header — a band of background above it reads as a mistake.

**Left column contents, in this order:**

1. One line of small letterspaced uppercase label text.
2. The `h1`. **Four words maximum.** It is an invitation to ask, not a claim
   about the business. Largest text on the page.
3. One supporting sentence, 30 words or fewer.
4. The question input: a single line with a **bottom border only**. No box, no
   rounded rectangle, no drop shadow, no filled background. The placeholder is a
   real example question, not "Type here".
5. The suggested questions as small outlined pills.
6. The answer region, directly beneath the pills.

**The measurable requirement:**

⛔ At a 1440×1000 viewport, tapping a suggested question must reveal the whole
answer **without scrolling**. Budget the vertical space so this holds. This is
why the layout is a split and not a full-bleed image — it is the demonstration
the entire page exists to make, and an answer below the fold is a failed hero.

Below 1000px the columns stack: text first, photograph beneath it.

---

## 2. Answers and refusals

The agent answers only from what the business published. Everything else is
refused. **A refusal is a product feature, not an error**, and must never be
styled as a warning, an alert, or a failure.

- Answer: coloured left rule, plus a small caption underneath naming the source
  — e.g. "Answered from what {business} have published".
- Refusal: a **visibly different** left rule colour, plus its own caption —
  e.g. "Not in the knowledge base — passed to the team".
- Both use the same type size, the same weight and the same calm tone. The
  refusal is not smaller, not italic, not red, and carries no warning icon.

---

## 3. Colour — derived, never invented

You are given brand colours extracted from the business's existing site. Build
a palette **from** them. Do not ignore them, and do not use them raw.

    --brand      the extracted primary, exactly as given
    --ink        near-black carrying the brand hue: same hue, chroma cut hard,
                 lightness ~8-12%. Never #000 — it reads cheap against photographs
    --paper      page background: brand hue, chroma 2-6%, lightness 94-97%.
                 Never #FFF unless the brand is genuinely stark
    --surface    a second background one step from paper, for alternating bands
    --line       ink at 10-16% alpha
    --accent     the brand colour, adjusted only as far as contrast demands

**Rules that are checked:**

- ⛔ The accent covers **less than 5% of the visible surface** of any screen.
  It is for one button, one rule, one underline — never a hero background, never
  a full-width band. A saturated brand colour used large is what makes a site
  look cheap, and most extracted brand colours are saturated.
- ⛔ Body text on paper: contrast ratio **≥ 7:1**. Large display text and
  secondary text: **≥ 4.5:1**. State the ratios you achieved in a CSS comment.
- ⛔ Never place text on a photograph without a scrim. Name which half of the
  image is dark, put the text there, and add a gradient behind it. Photographs
  vary and contrast is never left to the image alone.
- Exactly one accent. A second accent needs a stated reason in a comment.
- Define every colour once as a custom property on `:root`. No literal hex
  values anywhere else in the stylesheet.

---

## 4. Typography

- A display face and a text face. Two families, no more.
- Fluid scale with `clamp()`, six steps. Define them as custom properties and
  use nothing else — no ad-hoc `font-size` values.
- Display copy sets tight: `line-height` 1.0–1.15, negative letter-spacing.
- Body copy sets at 1.5–1.65, measure capped at 60–70 characters.
- Uppercase labels get 0.12–0.18em letter-spacing. Nothing else is uppercase.
- ⛔ A display headline that must break in a particular place gets an explicit
  `<br>`. `text-wrap: balance` overrides your intent and will choose three lines
  where you wanted two.

---

## 5. Microanimation

Every interactive element responds. The page is calm at rest and never moves on
its own.

**Required:**

| Element | Behaviour |
|---|---|
| Nav link hover | Underline wipes in from the left, 300ms |
| Suggested pill hover | Fills with ink, label inverts, lifts 1px, 240ms |
| Button hover | Background shifts, lifts 1px, 260ms |
| Input focus | Bottom border changes colour, 260ms |
| Answer reveal | Height opens via `grid-template-rows: 0fr → 1fr`, content fades and rises 8px behind it |
| Section entrance | Fades and rises 18px on scroll, IntersectionObserver, staggered ~80ms per sibling |
| Gallery image hover | Scales to 1.03 inside `overflow: hidden`, 600ms |
| Sticky header | Gains a hairline bottom border once scrolled |

**Rules:**

- ⛔ Animate `transform` and `opacity` only. Never `width`, `height`, `top`,
  `left`, `margin`, or `box-shadow` — they force layout on every frame.
- One shared easing custom property. Interaction 180–300ms, entrance 500–700ms.
- ⛔ Everything sits behind `@media (prefers-reduced-motion: no-preference)`.
  With motion reduced, the page renders complete and static — not invisible.
  This is the commonest way an entrance animation ships as a blank page.
- ⛔ The LCP element is never entrance-animated. It delays the largest paint by
  exactly the animation duration.
- **Forbidden:** parallax, scroll-jacking, carousels, auto-playing anything,
  bounce and elastic easings, spinners, counters that tick up, text that types
  itself, cursor followers, hover effects that move layout.

---

## 6. Responsive

- One fluid system, not a desktop layout with phone patches. `clamp()` for type
  and spacing; media queries only where the layout genuinely changes.
- Breakpoints: 640, 1000, 1440. No others without a reason in a comment.
- ⛔ No horizontal scroll at **320px**. Long words, tables and code wrap or
  scroll inside their own container, never the page body.
- Interactive targets ≥ 44×44px, with ≥ 8px between adjacent ones.
- Multi-column tables become stacked rows below 640px. Nothing is hidden on
  mobile that is not also redundant on desktop.
- Every `<img>` carries `width` and `height` so nothing shifts as it loads.
- Below the fold, images are `loading="lazy"`; the hero image is not.

---

## 7. Photography

- At least two images run **edge to edge** across the full viewport width.
  Timid inset thumbnails waste the one asset that sells the work.
- `object-fit: cover` with an explicit `aspect-ratio` on every image in a grid,
  so the layout drives the composition rather than whatever shape the file was.
- Alt text describes what is in the frame, specifically. Never "image of" and
  never the business name.

---

## 8. Copy

- ⛔ Derive every sentence from the supplied facts. Invent no prices, dates,
  awards, accreditations, client names, review counts or press mentions.
- ⛔ No aphorisms, proverbs or lines that sound quoted. A borrowed line puts a
  copyright claim on the customer's business. Every sentence must be plain
  original prose about this business.
- ⛔ Never assert a licence, certification, insurance or registration that is
  not in the supplied facts, however reasonable the inference.
- Short. A page with few words needs each one to carry weight.

---

## 9. Structure and accessibility

- One `h1` per page. Heading levels never skip.
- Landmarks: `header`, `nav`, `main`, `footer`. A skip link to `#main`.
- Visible `:focus-visible` on everything reachable by keyboard.
- Buttons are `<button>`, links are `<a>`. A `<div>` with a click handler is a
  defect.
- Form inputs have real `<label>` elements, visually hidden if the design needs
  the placeholder to carry the label.
