/* Alder & Stone — design study.
 *
 * ⛔ The pack below is a PROTOTYPE STAND-IN so the hero can be judged without a
 * backend. In production none of this is client-side: the widget posts to
 * /agent/turn, and the pack, the retrieval thresholds, the coverage guard and
 * the transcript all live server-side. Shipping the pack to the browser would
 * hand over the business's answers and make the refusal rule advisory.
 *
 * What IS faithful is the behaviour: a stored answer is returned or the question
 * is refused and logged. Nothing here composes text.
 */

const PACK = [
  {
    q: "What areas do you cover?",
    terms: ["area", "cover", "where", "portland", "location", "travel", "sellwood", "lake oswego"],
    a: "We work across Portland and the close-in suburbs — Sellwood, Laurelhurst, Irvington, Alameda, and out to Lake Oswego and West Linn. Beyond about 25 miles we take on design work only.",
  },
  {
    q: "What does a garden design cost?",
    terms: ["cost", "price", "charge", "much", "fee", "design fee", "budget"],
    a: "Design is charged separately from build. A full design for a typical city lot runs $3,500–$6,000 depending on survey and level of detail. Build is quoted once the drawings are agreed — we never quote a build from a photograph.",
  },
  {
    q: "How long does a project take?",
    terms: ["long", "take", "timeline", "how soon", "when", "lead time", "wait", "duration"],
    a: "Design takes six to ten weeks from the first site visit. Build depends on scope: a terrace and planting is usually three to four weeks on site, a full garden with structures runs eight to twelve.",
  },
  {
    q: "Do you do the building as well as the design?",
    terms: ["build", "install", "construction", "do the work", "yourselves", "subcontract", "own team"],
    a: "Yes. Everything hard-landscaping — stonework, timber, steel, drainage — is built by our own team. Planting is ours too. We bring in specialists only for electrical work and anything structural that needs an engineer's stamp.",
  },
  {
    q: "What is your planting style?",
    terms: ["planting", "style", "plants", "aesthetic", "look", "naturalistic", "grasses"],
    a: "Layered and seasonal, leaning on perennials and grasses that hold structure through winter rather than disappearing in October. We plant densely so the ground closes over and there is less weeding, not more.",
  },
  {
    q: "Do you maintain gardens after they are built?",
    terms: ["maintain", "maintenance", "aftercare", "upkeep", "look after", "care"],
    a: "For the first two seasons, yes — that period decides whether a planting scheme establishes. After that we hand over to a maintenance gardener with a written plan, and we come back twice a year for the structural pruning.",
  },
  {
    q: "Can you work with an existing garden?",
    terms: ["existing", "already", "keep", "renovate", "renovation", "partial", "mature"],
    a: "Often the best projects. Mature trees, an old wall, a level change worth keeping — we survey what is there first and design around it. A blank slate is usually a worse starting point.",
  },
  {
    q: "How do we start?",
    terms: ["start", "begin", "first step", "process", "next", "book", "consultation", "visit"],
    a: "A site visit, about ninety minutes, on site with you. We walk the space, talk about how you want to use it and what the budget is, and you get a written summary within a week. The visit is $180 and comes off the design fee if you go ahead.",
  },
];

/** Cheap keyword overlap. The real system uses cosine + BM25 fused by RRF, then
 *  a coverage check — this is only good enough to demonstrate the interaction. */
function retrieve(question) {
  const q = question.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const pair of PACK) {
    let score = 0;
    for (const term of pair.terms) if (q.includes(term)) score += term.length;
    if (score > bestScore) { bestScore = score; best = pair; }
  }
  return bestScore >= 4 ? best : null;
}

function initAsk(root) {
  const form = root.querySelector("[data-ask-form]");
  if (!form) return;
  const input = form.querySelector("input");
  const answer = root.querySelector("[data-answer]");
  const card = answer && answer.querySelector("[data-answer-card]");
  const body = answer && answer.querySelector("[data-answer-body]");
  const meta = answer && answer.querySelector("[data-answer-meta]");

  function respond(question) {
    if (!question.trim() || !answer) return;
    const hit = retrieve(question);
    // Collapse first so a second question re-plays the reveal rather than
    // swapping text underneath the reader.
    answer.dataset.open = "false";
    window.setTimeout(() => {
      if (hit) {
        card.dataset.kind = "answer";
        body.textContent = hit.a;
        meta.textContent = "Answered from what Alder & Stone have published";
      } else {
        card.dataset.kind = "refusal";
        body.textContent =
          "That is not something I can answer for them — I would only be guessing, and I would rather not. " +
          "Your question has been passed to the studio and someone will come back to you.";
        meta.textContent = "Not in the knowledge base · added to the studio's list";
      }
      answer.dataset.open = "true";
    }, answer.dataset.open === "true" ? 220 : 0);
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); respond(input.value); });
  root.querySelectorAll("[data-chip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      input.value = chip.textContent.trim();
      respond(input.value);
    });
  });
}

function initReveal() {
  const items = document.querySelectorAll("[data-reveal]");
  if (!items.length) return;
  if (!("IntersectionObserver" in window) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    items.forEach((el) => el.classList.add("is-in"));
    return;
  }
  // One observer for the whole page rather than one per element.
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-in");
      io.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });
  items.forEach((el) => io.observe(el));
}

function initNav() {
  const nav = document.querySelector(".nav");
  if (!nav) return;
  const sentinel = document.createElement("div");
  nav.before(sentinel);
  new IntersectionObserver(
    ([e]) => { nav.dataset.stuck = String(!e.isIntersecting); },
    { threshold: 1 },
  ).observe(sentinel);
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-ask]").forEach(initAsk);
  initReveal();
  initNav();
});
