"""Install Jev into a separate, local T3 profile on macOS."""

import argparse
import getpass
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile


SOURCE = Path(__file__).resolve().parent
FILES = ("agent.mjs", "dispatch.mjs", "router.mjs", "prompt.mjs", "quota.mjs",
         "classify.py", "jev_client.py", "profiles.json")
APP_REQUIREMENT = ('=anchor apple generic and identifier "com.t3tools.t3code"'
                   ' and certificate leaf[subject.OU] = "ARK85ZXQ4Z"')


def write_private(path, contents, mode=0o600):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(contents.encode())
            stream.flush()
            os.chmod(temporary, mode)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def verify_app(app):
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info.get("CFBundleShortVersionString") != "0.1.9":
        raise ValueError("Install signed T3 Code 0.1.9 at the app path supplied.")
    subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "-R", APP_REQUIREMENT, str(app)],
                   check=True)
    executable = (app / "Contents/MacOS" / info["CFBundleExecutable"]).resolve(strict=True)
    entrypoint = app / "Contents/Resources/app.asar/apps/server/dist/bin.mjs"
    if not (app / "Contents/Resources/app.asar").is_file():
        raise ValueError("The signed T3 app is missing its server package.")
    return executable, entrypoint


def install(profile, executable, entrypoint, node, python, port, full_access, key):
    data_dir = profile / "userdata"
    adapter = profile / "adapter"
    settings_path = data_dir / "settings.json"
    config_path = adapter / "config.json"
    if settings_path.exists() and not config_path.is_file():
        raise ValueError("Choose a fresh Jev profile directory. This path already holds T3 settings.")
    if key is not None and not re.fullmatch(r"[!-~]{1,512}", key):
        raise ValueError("Enter a non-empty TypeSafe key with no whitespace.")
    if key is None and not (adapter / "typesafe.key").is_file():
        raise ValueError("Set up your own TypeSafe key to continue.")
    for path in (profile, data_dir, adapter):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.is_symlink() or path.stat().st_uid != os.getuid():
            raise ValueError("The Jev profile must use directories you own.")
    os.chmod(adapter, 0o700)
    for name in FILES:
        write_private(adapter / name, (SOURCE / name).read_text())
    if key is not None:
        write_private(adapter / "typesafe.key", key + "\n")

    config = {
        "home": str(profile),
        "stateDir": str(profile / "jev/sessions"),
        "python": str(python),
        "bridge": {
            "executable": str(executable),
            "entrypoint": str(entrypoint),
            "endpointOrigin": f"http://127.0.0.1:{port}",
        },
        "profiles": json.loads((adapter / "profiles.json").read_text()),
        "cursorAllowThirdParty": False,
    }
    write_private(config_path, json.dumps(config, indent=2) + "\n")
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    settings["defaultModelSelection"] = {"instanceId": "jev-auto", "model": "auto", "options": []}
    settings["defaultRuntimeMode"] = "full-access" if full_access else "auto"
    settings.setdefault("providerInstances", {})["jev-auto"] = {
        "driver": "acpRegistry",
        "enabled": True,
        "displayName": "Jev Auto",
        "config": {"source": "local", "commandPath": str(node),
                   "commandArgs": [str(adapter / "agent.mjs")], "customModels": ["auto"]},
        "environment": [{"name": "JEV_T3_CONFIG", "value": str(config_path)}],
    }
    write_private(settings_path, json.dumps(settings, indent=2) + "\n")
    launcher = profile / "Jev T3.command"
    write_private(launcher, '\n'.join([
        '#!/bin/sh',
        'set -eu',
        f'export T3CODE_HOME={shlex.quote(str(profile))}',
        f'export T3CODE_PORT={port}',
        'export T3CODE_HOST=127.0.0.1',
        f'exec {shlex.quote(str(executable))} "$@"',
        '',
    ]), mode=0o700)
    return launcher


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=Path("/Applications/T3 Code (Beta).app"))
    parser.add_argument("--profile", type=Path, default=Path.home() / ".jev-t3-share")
    parser.add_argument("--port", type=int, default=8475)
    parser.add_argument("--full-access", action="store_true",
                        help="explicitly enable Full Access for new threads in this profile")
    parser.add_argument("--replace-key", action="store_true", help="enter a new TypeSafe key")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This installer targets macOS.")
    if sys.version_info < (3, 9):
        parser.error("Python 3.9 or newer is required.")
    if not 1024 <= args.port <= 65535:
        parser.error("Choose a TCP port from 1024 through 65535.")
    try:
        executable, entrypoint = verify_app(args.app.expanduser().resolve(strict=True))
        node = shutil.which("node")
        if not node or int(subprocess.check_output([node, "--version"], text=True).split(".")[0][1:]) < 22:
            raise ValueError("Node.js 22 or newer is required.")
        profile = args.profile.expanduser().absolute()
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", args.port))
            except OSError:
                raise ValueError("Quit the Jev profile using that port, or choose an unused port.") from None
        key = None
        if args.replace_key or not (profile / "adapter/typesafe.key").is_file():
            if not sys.stdin.isatty():
                raise ValueError("Run setup in Terminal to enter your own TypeSafe key.")
            key = getpass.getpass("Your TypeSafe API key: ").strip()
        launcher = install(profile, executable, entrypoint, Path(node).resolve(),
                           Path(sys.executable).resolve(), args.port, args.full_access, key)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        parser.exit(1, f"Setup stopped: {exc}\n")
    print(f"Installed Jev Auto. Open {launcher}")


if __name__ == "__main__":
    main()
