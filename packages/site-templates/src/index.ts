export {
  renderSite,
  renderLlmsTxt,
  validateSlots,
  weightKb,
  SlotViolationError,
  type BusinessRecord,
  type CopySlots,
  type RenderOptions,
} from "./render.ts";

/** Build a reviewer-gate artifact from a rendered preview (demo helper). */
export { buildArtifactFromHtml } from "./artifact.ts";
