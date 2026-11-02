// @effect-diagnostics nodeBuiltinImport:off - Bootstrap must isolate the profile before loading the runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { jevBootstrapEnvironment } from "./app/DesktopJevBootstrap.ts";

Object.assign(
  process.env,
  jevBootstrapEnvironment({
    resourcesPath: process.resourcesPath,
    homeDirectory: NodeOS.homedir(),
    env: process.env,
    readMarker: (path) => {
      try {
        const stat = NodeFS.lstatSync(path);
        if (!stat.isFile() || stat.size > 128) return { isFile: false, contents: "" };
        return { isFile: true, contents: NodeFS.readFileSync(path, "utf8") };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
  }),
);

require("./compileCache.cjs");
require("./main.cjs");
