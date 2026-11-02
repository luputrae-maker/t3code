# Jev integration

This folder is a standalone ACP addon, outside the T3 pnpm workspace. Install its single pinned dependency with `npm ci --ignore-scripts` here; use `npm test` for its Node test suite. T3 app checks still apply to changes outside this folder.

Preserve native T3 permissions. Do not expose the local UI broker as a model tool, approve without a matching T3 client decision, or hand off until the previous task is confirmed stopped. Keep runtime state and config.json out of Git. Never copy account data or keys into fixtures or skills.

The skills folder is vendored guidance with upstream licenses and pinned sources, not instructions to apply all skills to every task. Preserve it unless deliberately updating the relevant upstream version. Regenerate files.sha256.json after intentional public-source changes. Use OS temporary directories and isolated fixtures in tests; never launch against live T3 state.
