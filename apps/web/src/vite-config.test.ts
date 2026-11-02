// @effect-diagnostics nodeBuiltinImport:off -- Tests validate Vite's filesystem aliases without an Effect runtime.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import webConfig from "../vite.config.ts";

describe("web filesystem aliases", () => {
  it("resolves the CJK font alias to a real file, including checkouts on drives with spaces", async () => {
    const config =
      typeof webConfig === "function"
        ? await webConfig({ command: "serve", mode: "test" })
        : await webConfig;
    const aliases = config.resolve?.alias;
    if (!aliases || !("@betteroffice/fonts-cjk" in aliases))
      throw new Error("CJK font alias missing");
    const target = aliases["@betteroffice/fonts-cjk"];
    if (typeof target !== "string") throw new Error("CJK font alias must be a file path");
    expect(NodeFS.existsSync(target)).toBe(true);
  });
});
