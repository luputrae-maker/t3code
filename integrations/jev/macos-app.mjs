import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const usage = "Usage: node macos-app.mjs --source-app PATH --destination PATH";

function plistValue(plist, key, optional = false) {
  try {
    return NodeChildProcess.execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Print :${key}`, plist],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).replace(/\r?\n$/, "");
  } catch (error) {
    if (optional) return undefined;
    throw new Error(`Cannot read ${key} from the source app's Info.plist.`, { cause: error });
  }
}

function safeName(value) {
  if (!/^[A-Za-z0-9]/.test(value) || /[^A-Za-z0-9 ._()-]/.test(value)) {
    throw new Error("Unsafe app executable or icon filename.");
  }
  return value;
}

// The outer marker also isolates the bundled app when launched directly from the Dock.
export function buildMacosApp({ sourceApp, destination, readPlist = plistValue }) {
  if (!sourceApp || !destination) throw new Error(usage);
  sourceApp = NodeFS.realpathSync(sourceApp);
  destination = NodePath.resolve(destination);
  try {
    NodeFS.lstatSync(destination);
    throw new Error("Destination already exists; choose a new app path.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const relative = NodePath.relative(sourceApp, destination);
  if (
    !relative.startsWith(`..${NodePath.sep}`) &&
    relative !== ".." &&
    !NodePath.isAbsolute(relative)
  ) {
    throw new Error("Destination must be outside the source app.");
  }
  const plist = NodePath.join(sourceApp, "Contents", "Info.plist");
  const executable = safeName(readPlist(plist, "CFBundleExecutable"));
  NodeFS.accessSync(
    NodePath.join(sourceApp, "Contents", "MacOS", executable),
    NodeFS.constants.X_OK,
  );
  const icon = readPlist(plist, "CFBundleIconFile", true);
  const iconPath =
    icon === undefined
      ? undefined
      : NodePath.join(
          sourceApp,
          "Contents",
          "Resources",
          safeName(icon.endsWith(".icns") ? icon : `${icon}.icns`),
        );
  const hasIcon = iconPath !== undefined && NodeFS.existsSync(iconPath);
  NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
  NodeFS.mkdirSync(destination);
  try {
    const contents = NodePath.join(destination, "Contents");
    const resources = NodePath.join(contents, "Resources");
    NodeFS.mkdirSync(resources, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(contents, "MacOS"));
    NodeFS.writeFileSync(
      NodePath.join(resources, "jev-profile.json"),
      JSON.stringify({ edition: "jev-t3", version: 1 }) + "\n",
    );
    NodeFS.cpSync(sourceApp, NodePath.join(resources, "T3.app"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    if (hasIcon) NodeFS.copyFileSync(iconPath, NodePath.join(resources, "Jev.icns"));
    NodeFS.writeFileSync(
      NodePath.join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Jev T3</string>
<key>CFBundleDisplayName</key><string>Jev T3</string>
<key>CFBundleIdentifier</key><string>app.jev.t3</string>
<key>CFBundleExecutable</key><string>jev-t3</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>5</string>
<key>CFBundleShortVersionString</key><string>0.4.1</string>
${hasIcon ? "<key>CFBundleIconFile</key><string>Jev.icns</string>" : ""}
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
    );
    NodeFS.writeFileSync(
      NodePath.join(contents, "MacOS", "jev-t3"),
      `#!/bin/sh
set -eu
contents="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
export T3CODE_HOME="\${T3CODE_HOME:-$HOME/.t3-jev}"
export T3CODE_DESKTOP_USER_DATA_DIR="\${T3CODE_DESKTOP_USER_DATA_DIR:-$HOME/Library/Application Support/Jev T3}"
export T3CODE_DISABLE_AUTO_UPDATE=1
exec "$contents/Resources/T3.app/Contents/MacOS/${executable}" "$@"
`,
      { mode: 0o755 },
    );
  } catch (error) {
    NodeFS.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return destination;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
      console.log(usage);
    } else {
      const options = {};
      for (let index = 0; index < args.length; index += 2) {
        const key = { "--source-app": "sourceApp", "--destination": "destination" }[args[index]];
        if (!key || !args[index + 1] || options[key]) throw new Error(usage);
        options[key] = args[index + 1];
      }
      console.log(buildMacosApp(options));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
