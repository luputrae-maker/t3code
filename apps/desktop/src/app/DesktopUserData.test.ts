import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

it.effect.each(["t3code", "T3 Code (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "t3code-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "T3 Code (Alpha)"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses an isolated profile before inspecting or migrating the default profile", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-isolated-profile-" });
    const appDataDirectory = path.join(directory, "default");
    const userDataDirectory = path.join(directory, "custom");
    yield* fs.makeDirectory(path.join(appDataDirectory, "T3 Code (Alpha)"), { recursive: true });
    yield* fs.writeFileString(
      path.join(appDataDirectory, "T3 Code (Alpha)", "Local State"),
      "legacy credentials",
    );

    const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
      Effect.provide(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/dist-electron",
          homeDirectory: directory,
          platform: "win32",
          processArch: "arm64",
          appVersion: "0.1.6",
          appPath: "/repo",
          isPackaged: false,
          resourcesPath: "/repo/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            DesktopConfig.layerTest({
              APPDATA: appDataDirectory,
              T3CODE_DESKTOP_USER_DATA_DIR: userDataDirectory,
            }),
          ),
        ),
      ),
    );
    const actual = yield* resolveUserDataPath(environment);

    assert.equal(actual, userDataDirectory);
    assert.isTrue(yield* fs.exists(userDataDirectory));
    assert.isFalse(yield* fs.exists(path.join(userDataDirectory, "Local State")));
    assert.isFalse(yield* fs.exists(path.join(appDataDirectory, "t3code-v2")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a relative profile override instead of falling back to the shared profile", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      resolveUserDataPath({
        appDataDirectory: "/Users/alice/Library/Application Support",
        userDataDirectory: "relative-profile",
        isDevelopment: false,
        platform: "darwin",
      }),
    );

    assert.isTrue(Exit.isFailure(exit));
  }).pipe(Effect.provide(NodeServices.layer)),
);
