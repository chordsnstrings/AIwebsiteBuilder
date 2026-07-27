// The Browser capability — headless render used for preview screenshots and
// render-success checks. The screenshot hash is the artifact that matters: it
// is what a visual-regression gate compares between builds.
export interface RenderResult {
  html: string;
  screenshot: Buffer;
  screenshotHash: string;
}

export interface Browser {
  readonly vendorId: string;
  render(url: string): Promise<RenderResult>;
}
