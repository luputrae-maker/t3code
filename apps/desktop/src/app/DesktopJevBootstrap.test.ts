import { assert, it } from "@effect/vitest";

import { jevBootstrapEnvironment } from "./DesktopJevBootstrap.ts";

const resourcesPath = "/Applications/Jev T3.app/Contents/Resources/T3.app/Contents/Resources";
const marker = { isFile: true, contents: '{"edition":"jev-t3","version":1}' };

it.each([
  "/Applications/T3 Code.app/Contents/Resources",
  "/Applications/Jev T3.app/Contents/Resources/Other.app/Contents/Resources",
  "/Applications/Jev T3.app/Contents/Resources/T3.app/Contents/../Contents/Resources",
])("leaves stock and unexpected bundle paths unchanged: %s", (path) => {
  assert.deepEqual(
    jevBootstrapEnvironment({
      resourcesPath: path,
      homeDirectory: "/home/fixture",
      env: {},
      readMarker: () => {
        throw new Error("Must not inspect unrelated app markers");
      },
    }),
    {},
  );
});

it("leaves a nested app without a Jev marker unchanged", () => {
  assert.deepEqual(
    jevBootstrapEnvironment({
      resourcesPath,
      homeDirectory: "/home/fixture",
      env: {},
      readMarker: () => undefined,
    }),
    {},
  );
});

it("isolates a marked nested app before Electron startup", () => {
  const actual = jevBootstrapEnvironment({
    resourcesPath,
    homeDirectory: "/home/fixture",
    env: {},
    readMarker: (path) => {
      assert.equal(path, "/Applications/Jev T3.app/Contents/Resources/jev-profile.json");
      return marker;
    },
  });
  assert.deepEqual(actual, {
    T3CODE_HOME: "/home/fixture/.t3-jev",
    T3CODE_DESKTOP_USER_DATA_DIR: "/home/fixture/Library/Application Support/Jev T3",
    T3CODE_DISABLE_AUTO_UPDATE: "1",
  });
});

it("preserves explicit paths while disabling upstream updates", () => {
  assert.deepEqual(
    jevBootstrapEnvironment({
      resourcesPath,
      homeDirectory: "/home/fixture",
      env: {
        T3CODE_HOME: "/custom/state",
        T3CODE_DESKTOP_USER_DATA_DIR: "/custom/profile",
        T3CODE_DISABLE_AUTO_UPDATE: "0",
      },
      readMarker: () => marker,
    }),
    {
      T3CODE_HOME: "/custom/state",
      T3CODE_DESKTOP_USER_DATA_DIR: "/custom/profile",
      T3CODE_DISABLE_AUTO_UPDATE: "1",
    },
  );
});

it.each([
  { isFile: false, contents: marker.contents },
  { isFile: true, contents: "{" },
  { isFile: true, contents: '{"edition":"stock","version":1}' },
  { isFile: true, contents: '{"edition":"jev-t3","version":2}' },
  { isFile: true, contents: '{"edition":"jev-t3","version":1,"home":"/unsafe"}' },
  { isFile: true, contents: " ".repeat(256) + marker.contents },
])("fails closed for an invalid Jev marker: %j", (invalid) => {
  assert.throws(
    () =>
      jevBootstrapEnvironment({
        resourcesPath,
        homeDirectory: "/home/fixture",
        env: {},
        readMarker: () => invalid,
      }),
    /Invalid Jev app profile marker/,
  );
});
