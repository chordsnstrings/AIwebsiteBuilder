// Stateful in-memory ObjectStore simulator. Buffers are copied in and out so a
// caller can never mutate stored bytes by holding on to the reference it wrote.
import { BaseMockVendor, sha256Hex } from "../health.ts";
import type { ObjectStore, PutResult } from "./types.ts";

export class MockObjectStore extends BaseMockVendor implements ObjectStore {
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<PutResult> {
    this.assertUp("put");
    if (key.trim() === "") throw new Error("object key is required");
    const copy = Buffer.from(data);
    this.objects.set(key, copy);
    return { key, etag: sha256Hex(copy), size: copy.length };
  }

  async get(key: string): Promise<Buffer | null> {
    this.assertUp("get");
    const found = this.objects.get(key);
    return found ? Buffer.from(found) : null;
  }

  async delete(key: string): Promise<boolean> {
    this.assertUp("delete");
    return this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    this.assertUp("list");
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  size(): number {
    return this.objects.size;
  }

  protected override async probeOperation(): Promise<string> {
    const key = "__sentinel_probe__/round-trip.txt";
    const payload = Buffer.from(`sentinel probe ${this.vendorId}`, "utf8");
    const put = await this.put(key, payload);
    const got = await this.get(key);
    if (!got || !got.equals(payload)) throw new Error("probe object did not round trip");
    await this.delete(key);
    return `put+get+delete ${put.etag.slice(0, 8)}`;
  }
}
