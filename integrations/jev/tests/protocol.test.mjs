import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
async function protocolClient() {
  const directory = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jev-acp-test-")),
  );
  const child = NodeChildProcess.spawn(process.execPath, ["agent.mjs"], {
    cwd: new URL("../", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, JEV_T3_STATE: directory, TYPESAFE_API_KEY: "fixture" },
  });
  const lines = NodeReadline.createInterface({ input: child.stdout }),
    iter = lines[Symbol.asyncIterator]();
  let id = 0;
  return {
    directory,
    call: async (method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
      return JSON.parse((await iter.next()).value);
    },
    close: async () => {
      const exited = NodeEvents.once(child, "exit");
      child.stdin.end();
      child.kill();
      await exited;
      lines.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}
NodeTest.test(
  "ACP discovery advertises auto selection without Pi and cleanly rejects missing sessions",
  async () => {
    const c = await protocolClient();
    try {
      const first = await c.call("initialize", { protocolVersion: 1 });
      NodeAssert.equal(first.result.agentInfo.name, "Jev Auto");
      const missing = await c.call("session/prompt", { sessionId: "missing", prompt: [] });
      NodeAssert.equal(missing.error.code, -32602);
    } finally {
      await c.close();
    }
  },
);
NodeTest.test(
  "ACP setup replaces duplicate permission modes with one inherited-policy descriptor",
  async () => {
    const c = await protocolClient();
    try {
      const m = await c.call("session/new", { cwd: c.directory, mcpServers: [] });
      NodeAssert.equal(m.result.modes.currentModeId, "supervised");
      NodeAssert.deepEqual(
        m.result.modes.availableModes.map((v) => v.id),
        ["supervised"],
      );
    } finally {
      await c.close();
    }
  },
);
