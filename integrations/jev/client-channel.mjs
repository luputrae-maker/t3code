import * as NodeCrypto from "node:crypto";
export class ClientChannel {
  constructor(write) {
    this.write = write;
    this.pending = new Map();
  }
  requestPermission(sessionId, toolCall) {
    const id = "jev-ui-" + NodeCrypto.randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, { sessionId, resolve });
      this.write({
        id,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall,
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "decline", name: "Decline", kind: "reject_once" },
          ],
        },
      });
    });
  }
  handle(message) {
    if (message.method || !this.pending.has(message.id)) return false;
    const p = this.pending.get(message.id);
    this.pending.delete(message.id);
    p.resolve(message.error ? { outcome: { outcome: "cancelled" } } : message.result);
    return true;
  }
  cancel(sessionId) {
    for (const [id, p] of this.pending)
      if (!sessionId || p.sessionId === sessionId) {
        this.pending.delete(id);
        p.resolve({ outcome: { outcome: "cancelled" } });
      }
  }
}
