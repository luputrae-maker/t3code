// @effect-diagnostics nodeBuiltinImport:off - Runs before the Effect runtime and profile initialization.
import * as NodePath from "node:path";

interface JevBootstrapInput {
  readonly resourcesPath: string | undefined;
  readonly homeDirectory: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly readMarker: (
    path: string,
  ) => { readonly isFile: boolean; readonly contents: string } | undefined;
}

export function jevBootstrapEnvironment(input: JevBootstrapInput): Record<string, string> {
  const resourcesPath = input.resourcesPath;
  const suffix = NodePath.join("Contents", "Resources", "T3.app", "Contents", "Resources");
  if (
    resourcesPath === undefined ||
    !NodePath.isAbsolute(resourcesPath) ||
    NodePath.normalize(resourcesPath) !== resourcesPath ||
    !resourcesPath.endsWith(`${NodePath.sep}${suffix}`)
  )
    return {};
  const outerApp = resourcesPath.slice(0, -suffix.length - 1);
  if (!NodePath.basename(outerApp).endsWith(".app") || NodePath.basename(outerApp) === ".app")
    return {};
  const marker = input.readMarker(
    NodePath.join(outerApp, "Contents", "Resources", "jev-profile.json"),
  );
  if (marker === undefined) return {};
  const invalidMarker = () => new Error("Invalid Jev app profile marker.");
  if (!marker.isFile || Buffer.byteLength(marker.contents, "utf8") > 128) throw invalidMarker();
  let document: unknown;
  try {
    document = JSON.parse(marker.contents);
  } catch {
    throw invalidMarker();
  }
  if (
    typeof document !== "object" ||
    document === null ||
    Object.keys(document).length !== 2 ||
    !("edition" in document) ||
    document.edition !== "jev-t3" ||
    !("version" in document) ||
    document.version !== 1
  )
    throw invalidMarker();
  return {
    T3CODE_HOME: input.env.T3CODE_HOME?.trim()
      ? input.env.T3CODE_HOME
      : NodePath.join(input.homeDirectory, ".t3-jev"),
    T3CODE_DESKTOP_USER_DATA_DIR: input.env.T3CODE_DESKTOP_USER_DATA_DIR?.trim()
      ? input.env.T3CODE_DESKTOP_USER_DATA_DIR
      : NodePath.join(input.homeDirectory, "Library", "Application Support", "Jev T3"),
    T3CODE_DISABLE_AUTO_UPDATE: "1",
  };
}
