# Alder & Stone — front-end design study

A complete five-page site for a fictional garden design and build studio in
Portland, Oregon. Look and feel only; the backend comes after.

    index.html      home — the question box is the hero
    work.html       four projects
    services.html   consultation / design / build / aftercare
    studio.html     the people and the argument for doing both
    contact.html    site-visit request

Open `index.html` directly, or `python3 -m http.server` from this directory.

## The idea being tested

The hero is not a headline about the business. It is a question box, because a
business a visitor can interrogate is the thing v3 actually sells. Ask something
the studio has published and you get their words back; ask something they have
not and you get a refusal, styled differently on purpose — a refusal is a
feature, not an error state.

## Photography

Six images, generated with BytePlus ModelArk (`seedream-5-0-260128`) and
downscaled to display width. No faces appear in any of them.

## What is prototype-only

⛔ `assets/site.js` carries a small Q&A pack client-side so the hero can be
judged without a backend. Production does none of this: the widget posts to
`/agent/turn`, and the pack, the retrieval thresholds, the coverage guard and
the transcript all stay server-side. Shipping the pack to the browser would hand
over the business's answers and reduce the refusal rule to a suggestion.

Fonts load from Google here for iteration speed. Production self-hosts them —
`config/allowlists.yaml` permits `self` and `cdn.adwsites.com` and nothing else.

The contact form and the site-visit request are inert.
