// @adw/publish — publishing connectors (MF12, 12 units) and content drafting
// (MF13, 13 units).
//
// The system could build a site. It could not say anything afterwards: no post,
// no listing update, no offer, no article, not even a ping to tell a search
// engine the site had changed.
//
// ⛔ The state machine IS the safety property:
//
//     draft ──approve──▶ approved ──publish──▶ published
//        └──reject──▶ rejected
//
// `publishApproved` reads `approved` and nothing else, and the database refuses
// to change the body of anything already approved. A system that posts
// unattended to a business's Google profile can say something wrong in their
// name, in public, and the correction never travels as far as the mistake.

export {
  allChannels,
  channelById,
  channelFor,
  channelVersion,
  channelsFor,
  clearChannelCache,
  CONNECTOR_IDS,
  type Channel,
  type ConnectorId,
} from "./catalogue.ts";

export {
  draftPublication,
  factsOnlyDrafter,
  publicationKey,
  type DraftInput,
  type DraftResult,
  type Drafter,
} from "./draft.ts";

export {
  approvePublication,
  pendingApproval,
  publicationLog,
  publishApproved,
  rejectPublication,
  simulatedConnectors,
  type ApproveResult,
  type Connector,
  type ConnectorInput,
  type ConnectorResult,
  type Connectors,
  type PublicationRow,
  type PublishRunResult,
} from "./publish.ts";
