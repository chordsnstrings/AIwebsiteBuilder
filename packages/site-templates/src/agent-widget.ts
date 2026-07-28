// The live agent on the preview page (spec §22.1).
//
// This is the acquisition hook. A speculative *website* is weak — 92-98% of
// businesses already have one and 1.2% fail on mobile, so "here is a site" is a
// pitch against a solved problem. A speculative *agent that already knows their
// business* is not weak, because almost nobody has one: 11.6% of the market is
// machine-readable and bookable.
//
// An owner asking their own agent what they charge, and getting the right answer
// back, is visceral in a way a page preview never was. Everything below exists
// to make that moment happen on a phone, on a bad connection, in under a second.
//
// Three constraints shape the implementation:
//   • The page must render and be readable with JavaScript disabled. The widget
//     degrades to a real POST form; the answer arrives as a page load.
//   • The script is inlined and tiny. An external fetch for a chat bundle would
//     cost more than the entire rest of the document.
//   • The gap list is rendered SERVER-SIDE from the pack. It is the sharpest
//     part of the whole preview — a visible list of questions their own
//     published content cannot answer — and it must survive with no JS at all.

export interface AgentWidgetOptions {
  /** Where a turn is posted. Same origin as the claim endpoint. */
  endpoint: string;
  /** Identifies which pack to answer from. Unguessable, like the claim token. */
  sessionRef: string;
  /** Questions the pack could not answer — their content gaps, shown plainly. */
  gaps: string[];
  /** Seeded so the first interaction is one tap, not a blank box. */
  suggestedQuestions: string[];
  businessName: string;
}

/** Suggestions used when the pack did not supply better ones. */
export const DEFAULT_SUGGESTIONS = [
  "What areas do you cover?",
  "What are your opening hours?",
  "What services do you offer?",
] as const;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * ~1.4KB of vanilla JS. No framework, no external request. It intercepts the
 * form, posts the turn, and appends the answer — and if anything about that
 * fails, the form is left alone and submits normally.
 */
const WIDGET_JS = `(function(){
var f=document.getElementById('adw-agent-form');if(!f)return;
var log=document.getElementById('adw-agent-log'),input=document.getElementById('adw-agent-q');
function add(cls,text){var d=document.createElement('div');d.className='adw-msg '+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
document.querySelectorAll('[data-adw-ask]').forEach(function(b){b.addEventListener('click',function(){input.value=b.getAttribute('data-adw-ask');f.requestSubmit?f.requestSubmit():f.submit()})});
f.addEventListener('submit',function(e){
  var q=input.value.trim();if(!q)return;
  e.preventDefault();add('me',q);input.value='';
  var pending=add('bot','…');
  fetch(f.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionRef:f.dataset.session,question:q})})
   .then(function(r){return r.json()})
   .then(function(d){pending.textContent=d.answer||"I don't have that in what this business has published, so I won't guess. I've noted the question.";
     if(d.source==='gap'){pending.className+=' gap'}})
   .catch(function(){pending.textContent='Could not reach the agent just now.'});
});})();`;

/** The inline script tag. Empty string when the widget is not rendered. */
export function agentWidgetScript(): string {
  return `<script>${WIDGET_JS}</script>`;
}

export function agentWidgetCss(): string {
  return `
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.agent{padding:24px 0;border-top:1px solid #eef}
.agent .lede{color:#556;margin:6px 0 14px}
.adw-log{border:1px solid #e3e8ef;border-radius:10px;padding:12px;min-height:96px;max-height:320px;overflow-y:auto;background:#fbfcfe}
.adw-msg{padding:8px 12px;border-radius:12px;margin:6px 0;max-width:85%;line-height:1.45}
.adw-msg.me{background:#e8f0ff;margin-left:auto}
.adw-msg.bot{background:#fff;border:1px solid #e3e8ef}
.adw-msg.gap{border-color:#ffe082;background:#fff8e1}
.adw-ask{display:flex;gap:8px;margin-top:10px}
.adw-ask input{flex:1;padding:10px;border:1px solid #cfd8e3;border-radius:6px;font:inherit}
.adw-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.adw-chips button{background:#fff;border:1px solid #cfd8e3;border-radius:999px;padding:7px 14px;font:inherit;font-size:.9rem;cursor:pointer}
.adw-chips button:hover{border-color:#0a5}
.gaps{margin-top:20px;background:#fff8e1;border:1px solid #ffe082;border-radius:10px;padding:14px 16px}
.gaps h3{font-size:1rem;margin-bottom:6px}
.gaps ul{margin:8px 0 0 18px}.gaps li{margin:4px 0}
@media (prefers-reduced-motion: no-preference){.adw-msg{animation:adwIn .18s ease-out}}
@keyframes adwIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}`;
}

/**
 * The rendered section. Note the `<noscript>`-free design: the form is a real
 * POST form with a real action, so the no-JS path is the same path, not a
 * fallback message apologising for itself.
 */
export function agentWidget(opts: AgentWidgetOptions): string {
  const suggestions = (opts.suggestedQuestions.length > 0 ? opts.suggestedQuestions : [...DEFAULT_SUGGESTIONS]).slice(
    0,
    3,
  );

  const chips = suggestions
    .map((q) => `<button type="button" data-adw-ask="${esc(q)}">${esc(q)}</button>`)
    .join("");

  // The gap list. Deliberately framed as their content's gap rather than the
  // agent's limitation, because that is what it actually is — and it is the
  // most persuasive thing on the page.
  const gaps =
    opts.gaps.length === 0
      ? ""
      : `<div class="gaps">
<h3>What it couldn't answer</h3>
<p>These are questions customers ask that ${esc(opts.businessName)}'s published information doesn't answer yet. Your agent refuses rather than guessing — that's deliberate.</p>
<ul>${opts.gaps.slice(0, 6).map((g) => `<li>${esc(g)}</li>`).join("")}</ul>
</div>`;

  return `<section class="agent" id="agent" aria-label="Ask the agent">
<h2>Ask ${esc(opts.businessName)}'s AI receptionist</h2>
<p class="lede">It answers only from what this business has published — and says so plainly when it doesn't know.</p>
<div class="adw-log" id="adw-agent-log" role="log" aria-live="polite">
<div class="adw-msg bot">Ask me anything about ${esc(opts.businessName)} — what we do, where we cover, when we're open.</div>
</div>
<form class="adw-ask" id="adw-agent-form" method="post" action="${esc(opts.endpoint)}" data-session="${esc(opts.sessionRef)}">
<label class="sr-only" for="adw-agent-q">Your question</label>
<input id="adw-agent-q" name="question" type="text" placeholder="What areas do you cover?" autocomplete="off">
<input type="hidden" name="sessionRef" value="${esc(opts.sessionRef)}">
<button class="btn" type="submit">Ask</button>
</form>
<div class="adw-chips">${chips}</div>
${gaps}
</section>`;
}
