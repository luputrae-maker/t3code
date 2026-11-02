import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { buildMacosApp } from "../macos-app.mjs";

const builder = NodeURL.fileURLToPath(new URL("../macos-app.mjs", import.meta.url));

function readPlist(plist, key, optional = false) {
  const value = NodeFS.readFileSync(plist, "utf8").match(
    new RegExp(`<key>${key}</key><string>([\\s\\S]*?)</string>`),
  )?.[1];
  if (value === undefined && !optional) throw new Error(`Missing fixture plist key: ${key}`);
  return value;
}

function fixture(t, executable = "T3 Code (Beta)", icon = "icon.icns") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jev-macos-app-"));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const sourceApp = NodePath.join(root, "Source T3.app");
  const destination = NodePath.join(root, "Shared Apps", "Jev T3.app");
  const macos = NodePath.join(sourceApp, "Contents", "MacOS");
  NodeFS.mkdirSync(macos, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(sourceApp, "Contents", "Resources"));
  NodeFS.writeFileSync(
    NodePath.join(sourceApp, "Contents", "Info.plist"),
    `<?xml version="1.0"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleIconFile</key><string>${icon}</string></dict></plist>`,
  );
  if (executable === "T3 Code (Beta)") {
    NodeFS.writeFileSync(
      NodePath.join(macos, executable),
      '#!/bin/sh\nprintf "%s\\n" "$T3CODE_HOME" "$T3CODE_DESKTOP_USER_DATA_DIR" "$T3CODE_DISABLE_AUTO_UPDATE" "$@"\n',
      { mode: 0o755 },
    );
  }
  NodeFS.writeFileSync(NodePath.join(sourceApp, "Contents", "Resources", "icon.icns"), "fake icon");
  return { root, sourceApp, destination };
}

NodeTest.test(
  "builds a portable wrapper with isolated defaults and preserves the source app",
  (t) => {
    const { root, sourceApp, destination } = fixture(t);
    const original = NodeFS.readFileSync(NodePath.join(sourceApp, "Contents", "Info.plist"));
    buildMacosApp({ sourceApp, destination, readPlist });
    NodeAssert.equal(
      NodeFS.existsSync(NodePath.join(destination, "Contents", "Resources", "jev-profile.json")),
      true,
    );
    NodeAssert.deepEqual(
      JSON.parse(
        NodeFS.readFileSync(
          NodePath.join(destination, "Contents", "Resources", "jev-profile.json"),
          "utf8",
        ),
      ),
      { edition: "jev-t3", version: 1 },
    );
    const launcher = NodePath.join(destination, "Contents", "MacOS", "jev-t3");
    NodeAssert.equal(NodeFS.existsSync(launcher), true);
    const home = NodePath.join(root, "unused home");
    const output = NodeChildProcess.execFileSync(launcher, ["argument with spaces"], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    NodeAssert.deepEqual(output.trimEnd().split("\n"), [
      NodePath.join(home, ".t3-jev"),
      NodePath.join(home, "Library", "Application Support", "Jev T3"),
      "1",
      "argument with spaces",
    ]);
    NodeAssert.equal(NodeFS.existsSync(home), false);
    NodeAssert.deepEqual(
      NodeFS.readFileSync(NodePath.join(sourceApp, "Contents", "Info.plist")),
      original,
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(destination, "Contents", "Resources", "Jev.icns"), "utf8"),
      "fake icon",
    );
    NodeAssert.equal(
      readPlist(NodePath.join(destination, "Contents", "Info.plist"), "CFBundleExecutable"),
      "jev-t3",
    );
    const override = NodeChildProcess.execFileSync(launcher, [], {
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        T3CODE_HOME: "/custom/state",
        T3CODE_DESKTOP_USER_DATA_DIR: "/custom/profile",
        T3CODE_DISABLE_AUTO_UPDATE: "0",
      },
      encoding: "utf8",
    });
    NodeAssert.deepEqual(override.trimEnd().split("\n"), ["/custom/state", "/custom/profile", "1"]);
  },
);

NodeTest.test("refuses an existing destination without changing its files", (t) => {
  const { sourceApp, destination } = fixture(t);
  NodeFS.mkdirSync(destination, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(destination, "keep"), "existing app");
  NodeAssert.throws(() => buildMacosApp({ sourceApp, destination, readPlist }), /already exists/i);
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(destination, "keep"), "utf8"), "existing app");
});

NodeTest.test("rejects unsafe executable and icon paths before creating output", (t) => {
  for (const [executable, icon] of [
    ["../escape", "icon.icns"],
    ["bad\nname", "icon.icns"],
    ["badname\n", "icon.icns"],
    ["$(touch unsafe)", "icon.icns"],
    ["T3 Code (Beta)", "../icon.icns"],
  ]) {
    const { sourceApp, destination } = fixture(t, executable, icon);
    NodeAssert.throws(() => buildMacosApp({ sourceApp, destination, readPlist }), /unsafe/i);
    NodeAssert.equal(NodeFS.existsSync(destination), false);
  }
});

NodeTest.test("CLI explains usage and rejects missing paths", () => {
  const help = NodeChildProcess.spawnSync(process.execPath, [builder, "--help"], {
    encoding: "utf8",
  });
  NodeAssert.equal(help.status, 0);
  NodeAssert.match(help.stdout, /--source-app.*--destination/);
  const missing = NodeChildProcess.spawnSync(process.execPath, [builder], { encoding: "utf8" });
  NodeAssert.equal(missing.status, 1);
  NodeAssert.match(missing.stderr, /--source-app.*--destination/);
});

NodeTest.test(
  "macOS CLI builds from explicit paths",
  { skip: !NodeFS.existsSync("/usr/libexec/PlistBuddy") },
  (t) => {
    const { sourceApp, destination } = fixture(t);
    const built = NodeChildProcess.spawnSync(
      process.execPath,
      [builder, "--source-app", sourceApp, "--destination", destination],
      { encoding: "utf8" },
    );
    NodeAssert.equal(built.status, 0, built.stderr);
    NodeAssert.equal(
      NodeFS.existsSync(
        NodePath.join(destination, "Contents", "Resources", "T3.app", "Contents", "Info.plist"),
      ),
      true,
    );
  },
);
