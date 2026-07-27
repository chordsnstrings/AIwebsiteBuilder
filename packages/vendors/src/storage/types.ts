// The ObjectStore capability (Cloudflare R2 shape). Artifacts, screenshots and
// evidence blobs go here; the etag is the content hash so callers can detect a
// no-op write without reading the object back.
export interface PutResult {
  key: string;
  etag: string;
  size: number;
}

export interface ObjectStore {
  readonly vendorId: string;
  put(key: string, data: Buffer): Promise<PutResult>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}
