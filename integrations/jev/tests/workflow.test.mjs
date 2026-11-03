import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { workflowBrief, selectedSkills, isLeafRequest } from "../workflow.mjs";
import { route } from "../routing.mjs";
import { taskTitle, routeMessage } from "../presentation.mjs";
const catalog = Object.fromEntries(
  [
    "t3-builder",
    "startup-workflow",
    "create-prd",
    "writing-plans",
    "evan-design",
    "anti-ai-slop",
    "verification-before-completion",
    "systematic-debugging",
    "security-review",
    "expo-overview",
    "expo-native-ui",
    "expo-router",
    "swiftui-expert-skill",
  ].map((n) => [n, "/fixture/" + n + "/SKILL.md"]),
);
NodeTest.test(
  "planning and mobile design select useful installed skills while omitting unavailable skills",
  () => {
    const plan = selectedSkills(
      { taskKind: "planning", stack: "general", scope: "plan_only" },
      catalog,
    );
    NodeAssert.ok(plan.some((s) => s.name === "writing-plans"));
    const build = selectedSkills({ taskKind: "coding", scope: "execute" }, catalog);
    NodeAssert.ok(!build.some((s) => s.name === "writing-plans"));
    NodeAssert.ok(plan.some((s) => s.name === "create-prd"));
    const mobile = selectedSkills({ taskKind: "design", stack: "expo" }, catalog);
    NodeAssert.ok(mobile.some((s) => s.name === "expo-native-ui"));
    NodeAssert.ok(mobile.some((s) => s.name === "evan-design"));
    NodeAssert.ok(!mobile.some((s) => s.name === "swiftui-expert-skill"));
    NodeAssert.ok(mobile.every((s) => catalog[s.name] === s.path));
    NodeAssert.ok(mobile.length <= 7);
  },
);
NodeTest.test(
  "quick replies avoid project workflow overhead and leaf tasks cannot create another team",
  () => {
    NodeAssert.deepEqual(selectedSkills({ taskKind: "quick", stack: "general" }, catalog), []);
    NodeAssert.equal(isLeafRequest("[jev-subtask:v1]\nReview the checkout code"), true);
    NodeAssert.equal(isLeafRequest("Explain the marker [jev-subtask:v1]"), false);
    NodeAssert.equal(
      isLeafRequest("Act as the research sub-agent for this task.\n\n[jev-subtask:v1] Read routes"),
      true,
    );
    NodeAssert.equal(
      taskTitle("Act as the research sub-agent for this task.\n\n[jev-subtask:v1] Read routes"),
      "Jev: Read routes",
    );
    NodeAssert.equal(taskTitle("[jev-subtask:v1]\nReview checkout"), "Jev: Review checkout");
    const guide = workflowBrief(
      { taskKind: "coding", stack: "general", collaboration: "parallel_build", leaf: true },
      catalog,
    );
    NodeAssert.match(guide, /leaf/i);
    NodeAssert.match(guide, /do not delegate/i);
  },
);
NodeTest.test("the visible route describes the planned workflow in readable terms", () => {
  const text = routeMessage({
    providerInstanceId: "codex",
    model: "fixture",
    options: [],
    taskKind: "planning",
    stack: "expo",
    scope: "plan_only",
    collaboration: "parallel_read",
  });
  NodeAssert.match(text, /Planned approach/);
  NodeAssert.match(text, /Expo mobile/);
  NodeAssert.match(text, /Planning only/);
  NodeAssert.doesNotMatch(text, /parallel_read|plan_only/);
  NodeAssert.doesNotMatch(text, /Selection basis|remaining allowance|no clear evidence/i);
});
NodeTest.test(
  "Jev chooses platform and collaboration in the first routing request; missing or invalid choices stay direct",
  async () => {
    const pool = [{ id: "r0", providerInstanceId: "codex", model: "fixture", options: [] }];
    let n = 0;
    const d = await route(pool, { request: "Build an Expo checkout", leaf: true }, async (body) => {
      if (++n === 1) {
        NodeAssert.ok(body.questions.stack);
        NodeAssert.ok(body.questions.collaboration);
        return {
          answers: {
            provider: { choice: "codex" },
            kind: { choice: "coding" },
            stack: { choice: "expo" },
            collaboration: { choice: "parallel_build" },
          },
        };
      }
      return { answers: { selection: { choice: "r0" } } };
    });
    NodeAssert.equal(d.stack, "expo");
    NodeAssert.equal(d.collaboration, "solo");
    NodeAssert.equal(d.leaf, true);
    n = 0;
    const invalid = await route(pool, { request: "test" }, async () =>
      ++n === 1
        ? {
            answers: {
              provider: { choice: "codex" },
              stack: { choice: "invented" },
              collaboration: { choice: "invented" },
            },
          }
        : { answers: { selection: { choice: "r0" } } },
    );
    NodeAssert.equal(invalid.stack, "general");
    NodeAssert.equal(invalid.collaboration, "solo");
  },
);
NodeTest.test(
  "portable design setups can use Impeccable when the personal coordinator is absent",
  () => {
    const skills = selectedSkills(
      { taskKind: "design", stack: "general" },
      {
        "t3-builder": "/skills/t3-builder/SKILL.md",
        impeccable: "/skills/impeccable/SKILL.md",
        "anti-ai-slop": "/skills/anti-ai-slop/SKILL.md",
      },
    );
    NodeAssert.ok(skills.some((s) => s.name === "impeccable"));
  },
);
NodeTest.test(
  "a fresh machine can discover the bundled starter skills without global skill installation",
  async (t) => {
    const fs = await import("node:fs");
    const os = (await import("node:os")).default;
    const path = await import("node:path");
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "jev-no-user-skills-"));
    try {
      t.mock.method(os, "homedir", () => temporary);
      NodeModule.syncBuiltinESMExports();
      const { installedSkills } = await import("../workflow.mjs");
      const found = installedSkills();
      NodeAssert.equal(
        found["t3-builder"],
        NodeURL.fileURLToPath(new URL("../skills/t3-builder/SKILL.md", import.meta.url)),
      );
      NodeAssert.match(found["t3-builder"] ?? "", /skills[/\\]t3-builder[/\\]SKILL\.md$/);
      NodeAssert.ok(found["startup-workflow"]);
      NodeAssert.ok(found["impeccable"]);
      NodeAssert.ok(!Object.values(found).some((file) => file.startsWith(temporary)));
    } finally {
      t.mock.restoreAll();
      NodeModule.syncBuiltinESMExports();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
);
NodeTest.test("an existing shared skill takes precedence over the bundled fallback", async (t) => {
  const fs = await import("node:fs");
  const os = (await import("node:os")).default;
  const path = await import("node:path");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "jev-user-skill-"));
  const file = path.join(temporary, ".agents/skills/t3-builder/SKILL.md");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture");
    t.mock.method(os, "homedir", () => temporary);
    NodeModule.syncBuiltinESMExports();
    const { installedSkills } = await import("../workflow.mjs");
    NodeAssert.equal(installedSkills()["t3-builder"], file);
  } finally {
    t.mock.restoreAll();
    NodeModule.syncBuiltinESMExports();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
