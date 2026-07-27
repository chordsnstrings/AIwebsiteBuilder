// The SiteHost capability. Deployment is content-addressed: the hash of the
// file set IS the version, so redeploying identical content is a no-op and
// rollback is just repointing a URL at a hash that is still in the store. There
// is no "undo" that has to reconstruct anything.
export interface DeployResult {
  url: string;
  contentHash: string;
  /** false when the deploy was a no-op because the content was already live. */
  created: boolean;
}

export interface SiteHost {
  readonly vendorId: string;
  deploy(artifactKey: string, files: Record<string, string>): Promise<DeployResult>;
  fetch(url: string): Promise<string | null>;
  rollback(url: string, hash: string): Promise<void>;
}
