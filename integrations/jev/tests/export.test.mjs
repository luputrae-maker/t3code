import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { verifyExport } from "../verify-export.mjs";
NodeTest.test(
  "the public export rejects private files, outside symlinks and changed or omitted source",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jev-export-"));
    try {
      NodeFS.writeFileSync(NodePath.join(directory, "agent.mjs"), "fixture");
      verifyExport(directory, { update: true });
      NodeAssert.equal(verifyExport(directory).files, 1);
      NodeFS.writeFileSync(NodePath.join(directory, "config.json"), "private fixture");
      NodeAssert.equal(verifyExport(directory).files, 1);
      NodeFS.writeFileSync(NodePath.join(directory, "agent.mjs"), "changed");
      NodeAssert.throws(() => verifyExport(directory), /hash/);
      NodeFS.writeFileSync(NodePath.join(directory, "agent.mjs"), "fixture");
      NodeFS.writeFileSync(NodePath.join(directory, "auth.json"), "fixture");
      NodeAssert.throws(() => verifyExport(directory), /Private file/);
      NodeFS.unlinkSync(NodePath.join(directory, "auth.json"));
      NodeFS.symlinkSync(
        NodePath.join(directory, "agent.mjs"),
        NodePath.join(directory, "linked.mjs"),
      );
      NodeAssert.throws(() => verifyExport(directory), /Symlink/);
      NodeFS.unlinkSync(NodePath.join(directory, "linked.mjs"));
      NodeFS.writeFileSync(NodePath.join(directory, "extra.mjs"), "fixture");
      NodeAssert.throws(() => verifyExport(directory), /missing or extra/);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
