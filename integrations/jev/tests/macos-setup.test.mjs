import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { providerRegistration, linkBundledSkills } from "../macos-setup.mjs";
NodeTest.test(
  "portable registration uses the chosen folder, contains no credential and does not change permissions",
  () => {
    const r = providerRegistration({
      directory: "/Volumes/Development/Jev",
      node: "/opt/homebrew/bin/node",
    });
    NodeAssert.equal(r.operation, "create");
    NodeAssert.equal(r.instance.config.commandArgs[0], "/Volumes/Development/Jev/agent.mjs");
    NodeAssert.ok(!/\/Users\/[^/]+\//.test(JSON.stringify(r)));
    NodeAssert.ok(!JSON.stringify(r).includes("runtimeMode"));
    NodeAssert.deepEqual(
      r.instance.environment.map((e) => e.name),
      ["JEV_T3_CONFIG"],
    );
    NodeAssert.throws(() =>
      providerRegistration({ directory: "/tmp/kit", instanceId: "../unsafe" }),
    );
  },
);
NodeTest.test(
  "skill-link preview writes nothing, and installation preserves existing entries including broken links",
  () => {
    const d = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jev-setup-"));
    const directory = NodePath.join(d, "kit"),
      home = NodePath.join(d, "home");
    try {
      NodeFS.mkdirSync(NodePath.join(directory, "skills/demo"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(directory, "skills/demo/SKILL.md"), "fixture");
      NodeFS.mkdirSync(NodePath.join(home, ".claude/skills/demo"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(home, ".claude/skills/demo/keep"), "existing");
      NodeFS.mkdirSync(NodePath.join(home, ".grok/skills"), { recursive: true });
      NodeFS.symlinkSync(NodePath.join(d, "missing"), NodePath.join(home, ".grok/skills/demo"));
      const before = linkBundledSkills({ directory, home });
      NodeAssert.equal(before.created.length, 4);
      NodeAssert.equal(before.preserved.length, 2);
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(home, ".codex")), false);
      const after = linkBundledSkills({ directory, home, apply: true });
      NodeAssert.equal(after.created.length, 4);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(home, ".claude/skills/demo/keep"), "utf8"),
        "existing",
      );
      NodeAssert.ok(NodeFS.lstatSync(NodePath.join(home, ".grok/skills/demo")).isSymbolicLink());
      NodeAssert.equal(linkBundledSkills({ directory, home, apply: true }).created.length, 0);
    } finally {
      NodeFS.rmSync(d, { recursive: true, force: true });
    }
  },
);
