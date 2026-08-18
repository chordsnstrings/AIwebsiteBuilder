// Assembling the cold email body.
//
// ⛔ WHY THIS IS A NAMED FUNCTION AND NOT FOUR LINES INSIDE THE SEND ACTIVITY.
// The body is the product's first delivery and the only artefact a recipient
// ever judges us by, and every rule about it is load-bearing:
//
//   * The legal blocks are substituted from config, never model-generated
//     (spec §60.1). A model that paraphrases an unsubscribe notice has written
//     a different legal notice.
//   * The preview URL is substituted too. The outreach role's prompt says
//     "never include a recipient address, link, or sender identity — those come
//     from the workflow", and nothing downstream ever supplied one: the link
//     reached the body only because demo mode's simulator interpolated it, so
//     against a real model every cold email went out with no preview link at
//     all. The pitch is "we built you a site, look at it".
//   * No preview means NO link and no preview claim. Substituting the foundry's
//     own marketing homepage — which is what used to happen — turns a lead the
//     workflow deliberately routed to a text-only pitch into someone who was
//     told a site was built for them and sent to our front page.
//
// Buried inline, none of those could be tested without standing up a database,
// a campaign, a sending asset and a transport. Named, they are assertions.

export interface ColdEmailParts {
  /** The model's prose. Must already be free of links — see `stripModelLinks`. */
  bodyText: string;
  /** The deployed preview, or null when none was generated for this lead. */
  previewUrl: string | null;
  /**
   * The jurisdiction's legal blocks, already resolved by locale.
   *
   * ⛔ Passed in rather than looked up, so this stays a pure function of its
   * inputs and every rule below can be asserted without config, a database or a
   * network. `{unsub_url}` inside the unsubscribe block is substituted here.
   */
  blocks: Record<string, string>;
  /** The one-click unsubscribe URL this system serves. */
  unsubscribeUrl: string;
  /** Sender identity, from config — never from a model. */
  entity: string;
  postalAddress: string;
  privacyUrl: string;
}

/** Where the preview link goes, if there is one. */
export const PREVIEW_CTA = "See it here:";

export function composeColdEmailBody(parts: ColdEmailParts): string {
  const blocks = parts.blocks;
  return [
    parts.bodyText,
    // ⛔ Conditional, not defaulted. There is no correct URL to fall back to.
    ...(parts.previewUrl === null ? [] : ["", `${PREVIEW_CTA} ${parts.previewUrl}`]),
    "",
    blocks["ai_disclosure"] ?? "",
    (blocks["unsubscribe"] ?? "").replace("{unsub_url}", parts.unsubscribeUrl),
    `${parts.entity}, ${parts.postalAddress}`,
    `Privacy: ${parts.privacyUrl}`,
  ].join("\n");
}
