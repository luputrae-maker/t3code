import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { HostClient, localHostOptions } from "./host-client.mjs";
const root = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const defaults = [
  "claudeAgent",
  "codex",
  "grok",
  "antigravity",
  "deepseek-api",
  "kimi-api",
  "openrouter-api",
];
export function providerRegistration({
  directory,
  node = process.execPath,
  configFile,
  instanceId = "jev-auto",
}) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(instanceId))
    throw Error("Invalid provider instance id");
  return {
    operation: "create",
    instanceId,
    instance: {
      driver: "acpRegistry",
      displayName: "Jev Auto",
      enabled: true,
      environment: [
        {
          name: "JEV_T3_CONFIG",
          value: configFile ?? NodePath.join(directory, "config.json"),
          sensitive: false,
        },
      ],
      config: {
        source: "local",
        commandPath: node,
        commandArgs: [NodePath.join(directory, "agent.mjs")],
      },
    },
  };
}
export function linkBundledSkills({ directory, home = NodeOS.homedir(), apply = false }) {
  const source = NodePath.join(directory, "skills");
  const created = [],
    preserved = [];
  const roots = [
    ".agents/skills",
    ".claude/skills",
    ".codex/skills",
    ".grok/skills",
    ".config/opencode/skills",
    ".gemini/skills",
  ];
  for (const name of NodeFS.readdirSync(source)) {
    const skill = NodePath.join(source, name);
    if (!NodeFS.existsSync(NodePath.join(skill, "SKILL.md"))) continue;
    for (const relative of roots) {
      const target = NodePath.join(home, relative, name);
      try {
        NodeFS.lstatSync(target);
        preserved.push(target);
        continue;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      created.push(target);
      if (apply) {
        NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
        NodeFS.symlinkSync(skill, target, "dir");
      }
    }
  }
  return { created, preserved };
}
async function main() {
  const args = process.argv.slice(2),
    action = args[0] ?? "check";
  if (!["check", "install", "help"].includes(action)) throw Error("Use check, install or help");
  if (action === "help") {
    console.log(
      "node macos-setup.mjs check|install [--url ws://127.0.0.1:3773/ws?orchestrationProtocol=2] [--base-dir PATH] [--providers ID,ID] [--set-default]\ncheck is read-only. install registers this folder and links bundled skills without replacing existing files.",
    );
    return;
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone ACP tooling has no Effect runtime.
  if (process.platform !== "darwin") throw Error("This setup is currently verified for macOS only");
  const value = (flag) => {
    const n = args.indexOf(flag);
    if (n < 0) return undefined;
    if (!args[n + 1] || args[n + 1].startsWith("--")) throw Error("Missing value for " + flag);
    return args[n + 1];
  };
  const options = localHostOptions({ url: value("--url"), baseDir: value("--base-dir") });
  const read = new HostClient(options);
  let config;
  try {
    config = await read.rpc("server.getConfig", {});
  } finally {
    read.close();
  }
  if (args.includes("--instance-id"))
    throw Error(
      "Use the canonical jev-auto instance; remove a superseded registration in T3 Settings before installing another folder.",
    );
  const instanceId = "jev-auto";
  const present = new Set(config.providers.filter((p) => p.enabled).map((p) => p.instanceId));
  const allowed = (value("--providers")?.split(",") ?? defaults).filter(
    (id) => present.has(id) && id !== instanceId,
  );
  if (!allowed.length)
    throw Error("Connect a native provider in T3 first, or use --providers with its instance id");
  if (allowed.some((id) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id)))
    throw Error("Invalid native provider id");
  const mutation = providerRegistration({ directory: root, instanceId });
  const existing = config.settings?.providerInstances?.[instanceId];
  const skillPlan = linkBundledSkills({ directory: root });
  if (action === "check") {
    console.log(
      JSON.stringify(
        {
          platform: "macOS",
          node: process.version,
          t3Reachable: true,
          nativeProviders: allowed,
          jevAlreadyRegistered: !!existing,
          skillLinksToCreate: skillPlan.created.length,
          existingSkillEntriesPreserved: skillPlan.preserved.length,
          willSetDefault: args.includes("--set-default"),
          registration: mutation,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (existing && existing.config?.commandArgs?.[0] !== mutation.instance.config.commandArgs[0])
    throw Error(
      "A different Jev installation already owns this id. Keep it or remove that superseded registration in T3 Settings first; no existing registration was changed.",
    );
  const configFile = NodePath.join(root, "config.json");
  if (!NodeFS.existsSync(configFile))
    NodeFS.writeFileSync(
      configFile,
      JSON.stringify(
        {
          allowedInstances: allowed,
          ui: {
            enabled: true,
            url: options.url,
            ...(options.baseDir ? { baseDir: options.baseDir } : {}),
          },
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  const write = new HostClient({
    ...options,
    scopes: ["settings:write", "providers:manage"],
    write: true,
  });
  try {
    if (!existing)
      await write.rpc("server.updateSettings", { patch: {}, providerInstanceMutation: mutation });
    if (args.includes("--set-default"))
      await write.rpc("server.updateSettings", {
        patch: { defaultModelSelection: { instanceId, model: "auto" } },
      });
  } finally {
    write.close();
  }
  const links = linkBundledSkills({ directory: root, apply: true });
  console.log(
    JSON.stringify(
      {
        registered: instanceId,
        createdSkillLinks: links.created.length,
        preservedSkillEntries: links.preserved.length,
        next: "In T3, add your own TYPESAFE_API_KEY as a sensitive Jev provider environment variable; connect your native subscriptions and MCP tools. Choose Permissions → Full access only when you want commands and edits without routine prompts.",
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      error.message +
        "\nJev setup could not finish. Check that T3 is running, the loopback URL and provider ids are correct, and this folder is writable. Existing registrations and skill entries are preserved. Run check first; see docs/macos-setup.md.",
    );
    process.exitCode = 1;
  });
