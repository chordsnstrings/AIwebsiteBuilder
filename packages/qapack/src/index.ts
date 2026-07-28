// Q&A pack generation, embedding and indexing (§21.3–21.5, HANDOVER A4→A5).
// The pack is what the customer's agent retrieves from at runtime; everything
// it contains traces to something the business published, or it is a refusal.
export type {
  ExcludedPair,
  KbConflict,
  KbFact,
  KbFactStatus,
  KnowledgeBase,
  PackCoverage,
  QAPack,
  QAPair,
  QAPairSource,
  TopicCoverage,
} from "./types.ts";
export { isApproved } from "./types.ts";

export {
  cosine,
  deserialiseEmbedding,
  EMBEDDING_DIMS,
  embedText,
  localEmbeddingProvider,
  serialiseEmbedding,
  type EmbeddingProvider,
} from "./embedding.ts";

export { packId, pairId } from "./ids.ts";

export {
  FACT_QUESTION_FORMS,
  loadVerticalTemplate,
  refusalFor,
  type RefusalRule,
  type TemplateQuestion,
  type VerticalTemplate,
} from "./template.ts";

export { DEDUPE_SIMILARITY, generateQAPack, type GenerateDeps } from "./generate.ts";

export { approvePack, loadQAPack, persistQAPack, type PackApproval } from "./store.ts";
