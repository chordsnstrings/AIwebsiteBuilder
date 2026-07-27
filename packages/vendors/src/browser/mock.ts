// Deterministic Browser simulator. Rendering the same URL twice returns byte-
// identical HTML and screenshot bytes, so a visual-regression gate that flags a
// hash change is flagging a real change and never a rendering nondeterminism.
import { BaseMockVendor, seedBytes, seedHex, sha256Hex } from "../health.ts";
import type { Browser, RenderResult } from "./types.ts";

const SCREENSHOT_BYTES = 256;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class MockBrowser extends BaseMockVendor implements Browser {
  private renders = 0;

  async render(url: string): Promise<RenderResult> {
    this.assertUp("render");
    if (!/^https?:\/\//.test(url)) throw new Error(`unsupported url '${url}'`);
    this.renders += 1;
    const safe = escapeHtml(url);
    const html =
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<title>${safe}</title></head><body><main data-url="${safe}">` +
      `${seedHex(16, "body", url)}</main></body></html>`;
    const screenshot = seedBytes(SCREENSHOT_BYTES, "screenshot", url);
    return { html, screenshot, screenshotHash: sha256Hex(screenshot) };
  }

  renderCount(): number {
    return this.renders;
  }

  protected override async probeOperation(): Promise<string> {
    const result = await this.render("https://sentinel-probe.invalid/");
    if (result.html.length === 0) throw new Error("probe render produced no html");
    if (result.screenshot.length !== SCREENSHOT_BYTES) throw new Error("probe screenshot truncated");
    return `render ${result.screenshotHash.slice(0, 8)}`;
  }
}
