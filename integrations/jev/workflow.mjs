import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { stripRolePrefix } from "./presentation.mjs";

const byKind = {
  planning: ["startup-workflow", "create-prd"],
  design: ["evan-design", "anti-ai-slop", "accessibility-audit"],
  coding: ["verification-before-completion"],
  debugging: ["systematic-debugging", "verification-before-completion"],
  review: ["requesting-code-review", "security-review", "verification-before-completion"],
  research: ["startup-workflow", "research-plan"],
  writing: ["doc-coauthoring"],
};
const byStack = {
  web: ["vercel-react-best-practices", "vercel-composition-patterns", "webapp-testing"],
  expo: ["expo-overview", "expo-native-ui", "expo-router"],
  swift: ["swiftui-expert-skill", "swift-concurrency", "swift-testing-expert"],
  cloudflare: ["cloudflare", "workers-best-practices", "wrangler"],
};
export const isLeafRequest = (text) => /^\[jev-subtask:v1\](?:\s|$)/.test(stripRolePrefix(text));
export function installedSkills() {
  const names = new Set([
    "t3-builder",
    "impeccable",
    "writing-plans",
    ...Object.values(byKind).flat(),
    ...Object.values(byStack).flat(),
  ]);
  const catalog = {};
  for (const name of names) {
    for (const root of [
      NodePath.join(NodeOS.homedir(), ".agents/skills"),
      NodePath.join(NodeOS.homedir(), ".codex/skills"),
      NodeURL.fileURLToPath(new URL("./skills/", import.meta.url)),
    ]) {
      const file = NodePath.join(root, name, "SKILL.md");
      if (NodeFS.existsSync(file)) {
        catalog[name] = file;
        break;
      }
    }
  }
  return catalog;
}
export function selectedSkills(target, catalog = installedSkills()) {
  if (target.taskKind === "quick") return [];
  const stack = ["design", "coding", "debugging", "review"].includes(target.taskKind)
    ? (byStack[target.stack] ?? [])
    : [];
  return [
    ...new Set([
      "t3-builder",
      ...(byKind[target.taskKind] ?? []),
      ...(target.scope === "plan_only" ? ["writing-plans"] : []),
      ...stack,
    ]),
  ]
    .map((name) =>
      name === "evan-design" && !catalog[name] && catalog.impeccable ? "impeccable" : name,
    )
    .filter((name) => catalog[name])
    .slice(0, 7)
    .map((name) => ({ name, path: catalog[name] }));
}
export function workflowBrief(target, catalog = installedSkills()) {
  const skills = selectedSkills(target, catalog);
  if (!skills.length && !target.leaf) return "";
  const team = target.leaf
    ? "This is a leaf specialist assignment. Do not delegate or launch further agents."
    : ({
        solo: "Do this task directly. Do not start subagents for routine work.",
        parallel_read:
          "Use bounded independent research or planning specialists when they add value; keep their work read-only unless explicitly assigned outputs.",
        parallel_build:
          "Use bounded coding specialists only for independent scopes; isolate writers and avoid overlapping edits.",
        review:
          "Implement or inspect the main work, then use one independent reviewer when useful; verify its findings before changing code.",
      }[target.collaboration] ?? "Work directly.");
  return [
    "Jev work brief:",
    `Work type: ${target.taskKind ?? "general"}; platform: ${target.stack ?? "general"}.`,
    team,
    target.scope === "plan_only"
      ? "Scope: planning/inspection only. Do not edit project files, install packages or begin implementation. Return the requested plan or findings."
      : "Scope: execute the user-authorized task, with inherited T3 permissions and project constraints. Plan mode is opt-in: do not add a separate planning approval stage. Answer advice or analysis requests as asked; they do not authorize implementation.",
    skills.length
      ? "Read t3-builder first, then load only the listed skills relevant to the current step. These are installed paths, not a claim that they have already been used."
      : "",
    ...skills.map((s) => `${s.name}: ${s.path}`),
    "Use the named repository and its instructions. Check actual native tools before claiming Figma, Mobbin, browser or tracker access. Follow the user's requested scope and existing authorization.",
  ]
    .filter(Boolean)
    .join("\n");
}
