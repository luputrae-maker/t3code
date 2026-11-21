# Jev Auto for T3

Jev Auto chooses a signed-in coding provider, model, and reasoning effort for
each request. T3 runs the work in a native child chat and can keep that chat
across follow-ups. This macOS installer uses the signed upstream T3 desktop app.
Jev skips model groups with exhausted quotas. If T3 confirms a quota rejection
before any work starts, Jev tries another eligible route automatically.

## Install on macOS

1. Install [T3 Code 0.1.9](https://github.com/pingdotgg/t3code/releases/tag/v0.1.9)
   in Applications, plus Node.js 22 or newer and Python 3.9 or newer.
2. Create your own API key in the [TypeSafe console](https://console.typesafe.ai/).
3. Unzip `jev-auto-macos.zip`, open Terminal in the extracted `jev-auto` folder,
   and run the setup command below. From a checkout of this branch, run it
   from `integrations/jev-auto`.

```sh
python3 setup.py --full-access
```

4. Enter your TypeSafe key when prompted. Quit any open T3 instance, then open
   the generated launcher:

```sh
open "$HOME/.jev-t3-share/Jev T3.command"
```

5. In T3, sign in to your own coding accounts under **Settings → Providers**.
   Open a project and start a **Jev Auto** chat. `/jev-status` lists the eligible
   providers and models without making a TypeSafe request.

The launcher opens an isolated T3 profile and sets the local bridge port.
Use the launcher each time. If your upstream app has a different name or
location, pass its path to setup with `--app`.

To update an existing installation, quit T3, unzip the newer release and rerun
setup with the same options you originally used. It reuses your TypeSafe key
and provider settings. Reopen the launcher and start a Jev Auto chat.

## Permissions and billing

`--full-access` sets the default for new chats in this profile. That grants
commands and file edits with your local user account’s access. Provider-specific
prompts, macOS permission requests, and sign-ins can still need your input.
Omit the flag for T3’s Auto permission mode.

Your key is stored in an owner-only file under the local profile. TypeSafe
receives the current request and recent routing context and charges your
TypeSafe account. Coding workers use the native provider accounts you connect
in T3. The installer keeps Cursor routing to its included Grok and Composer
models and OpenCode routing to OpenCode Go, with standard context options.

The published source and download contain the adapter and setup code. Setup
creates the credentials and T3 state on your Mac.
