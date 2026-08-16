// Loading config/channels.yaml.
//
// ⛔ The loader enforces the one rule the file exists to hold: a channel that
// carries claims may not be `approval: not_required`. Config is PR-gated, but a
// PR is a person reading a diff, and this is the diff a tired person waves
// through. A build failure is not.

import { config } from "@adw/config";
import { primaryArchetype } from "@adw/taxonomy";

export type ConnectorId = "gbp" | "social" | "site" | "reviews" | "listings" | "directory" | "feed" | "ads" | "search";

export const CONNECTOR_IDS: readonly ConnectorId[] = [
  "gbp", "social", "site", "reviews", "listings", "directory", "feed", "ads", "search",
];

export interface Channel {
  id: string;
  label: string;
  connector: ConnectorId;
  approvalRequired: boolean;
  /** Floor between publications on this channel for one customer. */
  cadenceDays: number;
  /** 0 means the channel carries structured data rather than prose. */
  maxChars: number;
  carriesClaims: boolean;
}

interface Loaded {
  version: string;
  channels: Record<string, Channel>;
  byArchetype: Record<string, string[]>;
}

let cache: Loaded | null = null;
export function clearChannelCache(): void {
  cache = null;
}

function build(): Loaded {
  const file = config.channels();
  const data = file.data as Record<string, unknown>;
  const raw = (data["channels"] ?? {}) as Record<string, Record<string, unknown>>;
  const channels: Record<string, Channel> = {};

  for (const [id, ch] of Object.entries(raw)) {
    const connector = ch["connector"];
    if (typeof connector !== "string" || !(CONNECTOR_IDS as readonly string[]).includes(connector)) {
      throw new Error(`channels.yaml: "${id}" names connector "${String(connector)}", which does not exist`);
    }
    const approval = ch["approval"];
    if (approval !== "required" && approval !== "not_required") {
      throw new Error(`channels.yaml: "${id}" approval must be "required" or "not_required"`);
    }
    const carriesClaims = ch["carries_claims"] === true;
    // ⛔ The rule. A channel that can express a price, a promise or an opinion
    // is approval-required, and there is no argument to be had.
    if (carriesClaims && approval !== "required") {
      throw new Error(`channels.yaml: "${id}" carries claims and must be approval: required`);
    }
    channels[id] = {
      id,
      label: typeof ch["label"] === "string" ? ch["label"] : id,
      connector: connector as ConnectorId,
      approvalRequired: approval === "required",
      cadenceDays: typeof ch["cadence_days"] === "number" ? ch["cadence_days"] : 0,
      maxChars: typeof ch["max_chars"] === "number" ? ch["max_chars"] : 0,
      carriesClaims,
    };
  }

  const selection = (data["archetype_channels"] ?? {}) as Record<string, string[]>;
  const byArchetype: Record<string, string[]> = {};
  for (const [code, ids] of Object.entries(selection)) {
    for (const id of ids ?? []) {
      if (channels[id] === undefined) throw new Error(`channels.yaml: archetype ${code} selects unknown channel "${id}"`);
    }
    byArchetype[code] = [...(ids ?? [])];
  }
  return { version: file.version, channels, byArchetype };
}

function loaded(): Loaded {
  if (cache === null) cache = build();
  return cache;
}

export function channelVersion(): string {
  return loaded().version;
}

export function channelsFor(vertical: string): Channel[] {
  const code = primaryArchetype(vertical);
  if (code === undefined) return [];
  return (loaded().byArchetype[code] ?? []).map((id) => loaded().channels[id]!).filter((ch) => ch !== undefined);
}

export function channelFor(vertical: string, channelId: string): Channel | undefined {
  return channelsFor(vertical).find((ch) => ch.id === channelId);
}

export function channelById(channelId: string): Channel | undefined {
  return loaded().channels[channelId];
}

export function allChannels(): Channel[] {
  return Object.values(loaded().channels);
}
