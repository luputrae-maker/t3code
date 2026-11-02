# Share Jev Auto on macOS

This is an addon for the official T3 Code app. It uses T3's native agents, permissions, checklists and approval controls. It does not include accounts, keys, chats, project files or application databases. Keep the extracted folder in its permanent development location before registering it; moving it later breaks its registered command and skill links.

## Install on a friend's Mac

1. Install and open T3 Code from its official source. Install Node.js 22 or later from its official source or your existing package manager.
2. Connect the native providers you want in T3. Each person uses their own subscription or API account. The kit does not purchase access, move OAuth tokens or set up the machine-specific API wrappers from the original Mac.
3. Extract this kit into your development drive, then run in that folder:

   ```sh
   npm ci --ignore-scripts
   node macos-setup.mjs check
   node macos-setup.mjs install --set-default
   ```

   `check` changes no settings or files. `install` registers this folder as `jev-auto` and links the bundled skills where native runners look for them. Existing skill folders and broken links are preserved for manual review. Omit `--set-default` to leave the current T3 default alone. A different installation owning `jev-auto` is never overwritten; keep it or remove the superseded registration in T3 Settings before registering another folder. To use custom native provider ids, supply `--providers id1,id2`. If T3 uses another local port/data directory, supply `--url` and `--base-dir` consistently.

4. In T3 Settings → Providers → Jev Auto, add your own `TYPESAFE_API_KEY` as a **sensitive environment variable**. This is Jev's routing API key, separate from model subscriptions. Use your own existing account/budget. Do not put it into the kit or send it to someone else. Existing Macs can continue using their own pre-existing Jev credential store.
5. Refresh provider discovery, then select **Jev Auto / auto**. Start a small test request. Jev picks a configured native provider, its supported model and effort, and relevant installed skills. Agents use the tools actually authorized in that runner.

## Planning and provider limits

Send `/plan` to keep the chat in planning mode, or `/plan your task` to start planning immediately. Subsequent tasks and automatic provider handoffs keep native plan mode. Send `/build` to return to implementation. These commands preserve T3 permissions and will ask you to finish or cancel attached work before changing modes.

Recognized provider quota failures cause a handoff to another eligible connected provider after the affected task and descendants stop. The request and prior activity are carried forward; the limited connection is excluded for 30 minutes, with at most six attempts per chain. Jev does not know balances in advance. Direct Claude and Antigravity are separate connections. Ordinary failures, account sign-ins and permission requests are not automatically retried.

## Permissions

Open **Jev Auto → Permissions** in the composer:

- **Supervised:** ask before commands and file changes.
- **Auto-accept edits:** approve edits, ask before other actions.
- **Auto:** routine actions are approved by supported providers; others can still ask.
- **Full access:** commands and edits run without routine prompts.

The addon inherits this T3 setting. It never changes permissions from inside a running turn. Planning-only requests still use native planning mode. Provider sign-ins, plan approvals, unavailable tools and account limits can still require a response. A currently running child keeps the policy it started with.

## Design tools and project tracking

Connect Figma and Mobbin separately in each native runner that needs them, using the vendors' supported integrations and your own existing accounts. Skills do not create a tool connection or transfer a paid entitlement. Confirm a small read operation before claiming an integration works. Keep one design system and one authoritative tracker per project; deploy a tracker only when the project scope and hosting are decided.

The starter skill bundle covers product discovery, strategy, PRDs, prioritization, pricing, marketing, Expo, browser testing, CI assistance and threat modeling, with the T3 Builder coordinator and design review guidance. It does not copy the original Mac's entire personal skill library. The source manifest records revisions and hashes; upstream licenses remain with their files. Additional installed skills are picked up automatically when relevant. Some design tooling downloads its official engine on first use.

## Verify and recover

`npm test` runs offline integration and policy tests, including a temporary loopback WebSocket server. Main-chat team milestones describe actual task-state changes; its native checklist and tool activity hold more detail. Approvals are relayed only from the bound execution family and are revalidated before a one-time response. In Full access T3 can supply that response automatically. Questions are forwarded to the same pending request when you reply in the main chat.

If the live overview disconnects, work remains attached: send `/jev-status` in the same chat. Do not redispatch it. Ordinary errors are reported; only recognized current-run provider quota diagnostics trigger bounded fallback after the affected child and its descendants have stopped. Attachment forwarding is not implemented: use an appropriate native provider for images/files. Native tool support differs across providers.

A new Mac's account sign-ins and end-to-end installation must be verified there. This package has been tested on the original macOS host, not every macOS version or provider configuration. To roll back, choose a native provider or remove the Jev instance in T3 Settings. Never delete the kit while a running task or skill link still depends on it.
