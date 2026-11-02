import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
const root = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const manifestName = "files.sha256.json";
export function publicFiles(directory) {
  const result = [];
  const visit = (relative) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(directory, relative), {
      withFileTypes: true,
    })) {
      if (
        ["node_modules", ".git", ".t3", ".DS_Store"].includes(entry.name) ||
        entry.name.startsWith("._")
      )
        continue;
      const name = NodePath.posix.join(relative, entry.name);
      if (
        !relative &&
        (entry.name === "config.json" ||
          entry.name === ".setup-state.json" ||
          entry.name === ".env" ||
          entry.name.startsWith(".env."))
      )
        continue;
      if (entry.isSymbolicLink()) throw Error("Symlink in public source: " + name);
      if (entry.isDirectory()) {
        visit(name);
        continue;
      }
      if (name === manifestName) continue;
      if (entry.name.startsWith(".") && ![".gitignore", ".gitattributes"].includes(entry.name))
        throw Error("Unexpected hidden source: " + name);
      if (/(?:\.(?:sqlite|db|pem|key)$)|^(?:auth|secrets|credentials)\.json$/i.test(entry.name))
        throw Error("Private file in public source: " + name);
      result.push(name);
    }
  };
  visit("");
  return result.sort();
}
export function verifyExport(directory, { update = false, tracked = false } = {}) {
  const files = publicFiles(directory),
    hashes = {};
  for (const file of files) {
    const bytes = NodeFS.readFileSync(NodePath.join(directory, file));
    if (/\/Users\/[^/\s"']+\/|MacOffload\/Storage-/.test(bytes.toString("utf8")))
      throw Error("Machine-specific path in public source: " + file);
    hashes[file] = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  }
  const manifestPath = NodePath.join(directory, manifestName);
  if (update) NodeFS.writeFileSync(manifestPath, JSON.stringify(hashes, null, 2) + "\n");
  const expected = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(files))
    throw Error("Public file manifest has missing or extra files");
  for (const file of files)
    if (expected[file] !== hashes[file]) throw Error("Public file hash changed: " + file);
  if (tracked) {
    const committed = NodeChildProcess.execFileSync(
      "git",
      ["ls-files", "--cached", "-z", "--", "."],
      {
        cwd: directory,
        encoding: "utf8",
      },
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(committed) !== JSON.stringify([...files, manifestName].sort()))
      throw Error("Git file list differs from the reviewed public manifest");
  }
  return { files: files.length, tracked };
}
if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(
        verifyExport(root, {
          update: process.argv.includes("--update"),
          tracked: process.argv.includes("--tracked"),
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
