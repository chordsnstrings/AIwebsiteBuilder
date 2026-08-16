// @adw/uploads — the primitive 112 catalogue units were blocked on.
//
// There was no file upload route anywhere in the API and `photo_assessments`
// had no writer, so MF6 (100 units of document collection and assembly) and
// MF9 (12 units of vision assessment) were both dead on arrival — not missing
// features, missing a primitive.
//
// Two rules carried from the catalogue's own wording:
//   ⛔ MF6: "collects and tracks on schedule; performs no assessment"
//   ⛔ MF9: "assesses, never prices"
export {
  MAX_BYTES,
  UnsupportedUploadError,
  assertUploadable,
  sniff,
  type Sniffed,
} from "./sniff.ts";

export {
  DEFAULT_RETENTION_DAYS,
  UploadAccessError,
  acceptUpload,
  mintStorageKey,
  purgeExpired,
  readUpload,
  type AcceptInput,
  type AcceptedUpload,
  type UploadDeps,
} from "./store.ts";

export {
  assemblePack,
  attachDocument,
  clearPackCache,
  dueChases,
  loadRequest,
  maxChases,
  openRequest,
  packById,
  packsFor,
  type ChaseDue,
  type DocumentPack,
  type DocumentRequestRecord,
  type PackItem,
  type PackManifest,
} from "./documents.ts";

export {
  consentedPhotos,
  grantMarketingConsent,
  ownerPrices,
  recordAssessment,
  type PhotoAssessment,
  type RecordAssessmentInput,
} from "./photos.ts";
