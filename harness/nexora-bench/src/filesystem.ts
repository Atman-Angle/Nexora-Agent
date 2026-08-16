import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { digestText, stableDigest } from "./contracts.js";

export function resolveInside(root: string, requestedPath: string, options: { allowRoot?: boolean } = {}): string {
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, requestedPath);
  const fromRoot = relative(normalizedRoot, target);
  if (
    (!options.allowRoot && fromRoot === "")
    || fromRoot.startsWith("..")
    || isAbsolute(fromRoot)
  ) {
    throw new Error(`Path escapes or aliases its allowed root: ${requestedPath}`);
  }
  return target;
}

export function copyVerifiedFixture(source: string, expectedDigest: string, target: string): void {
  const actualDigest = directoryDigest(source);
  if (actualDigest !== expectedDigest) {
    throw new Error(`Fixture digest mismatch. Expected ${expectedDigest}, received ${actualDigest}.`);
  }
  copyDirectory(source, target);
}

export function copyDirectoryTree(source: string, target: string): void {
  copyDirectory(source, target);
}

export function directoryDigest(root: string): string {
  if (!statSync(root).isDirectory()) throw new Error(`Fixture is not a directory: ${root}`);
  return stableDigest(snapshotDirectory(root));
}

export function snapshotPaths(root: string, paths: readonly string[]): Readonly<Record<string, string | null>> {
  return Object.fromEntries(paths.map((requestedPath) => {
    const path = resolveInside(root, requestedPath);
    if (!existsSync(path)) return [requestedPath, null];
    if (!lstatSync(path).isFile()) throw new Error(`Expected a file for snapshot: ${requestedPath}`);
    return [requestedPath, digestText(readFileSync(path))];
  }));
}

function snapshotDirectory(root: string): unknown {
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map((entry) => {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Fixture cannot contain symbolic links: ${path}`);
      if (entry.isDirectory()) {
        return { path: entry.name, type: "directory", entries: snapshotDirectory(path) };
      }
      if (!entry.isFile()) throw new Error(`Unsupported fixture entry: ${path}`);
      return {
        path: entry.name,
        type: "file",
        digest: digestText(readFileSync(path)),
        byteLength: statSync(path).size
      };
    });
}

function copyDirectory(source: string, target: string): void {
  if (existsSync(target)) throw new Error(`Fixture target already exists: ${target}`);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Fixture cannot contain symbolic links: ${sourcePath}`);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    else if (entry.isFile()) copyFileSync(sourcePath, targetPath);
    else throw new Error(`Unsupported fixture entry: ${sourcePath}`);
  }
}
