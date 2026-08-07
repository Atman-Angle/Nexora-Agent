import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type ArtifactReference = {
  readonly digest: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly path: string;
};

export class ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
    mkdirSync(this.#root, { recursive: true });
  }

  putText(content: string, mediaType = "text/plain"): ArtifactReference {
    const bytes = Buffer.from(content, "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const digest = `sha256:${hash}`;
    const path = join(this.#root, hash);
    if (!existsSync(path)) {
      const temporary = join(this.#root, `.${hash}.${randomUUID()}.tmp`);
      writeFileSync(temporary, bytes, { flag: "wx" });
      try {
        if (existsSync(path)) rmSync(temporary, { force: true });
        else renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    }
    return { digest, mediaType, byteLength: bytes.byteLength, path };
  }

  getText(digest: string): string {
    return readFileSync(this.#pathForDigest(digest), "utf8");
  }

  has(digest: string): boolean {
    return existsSync(this.#pathForDigest(digest));
  }

  #pathForDigest(digest: string): string {
    const match = /^sha256:([a-f0-9]{64})$/.exec(digest);
    if (match === null) throw new Error(`Invalid Artifact digest: ${digest}`);
    const hash = match[1];
    if (hash === undefined) throw new Error(`Invalid Artifact digest: ${digest}`);
    return join(this.#root, hash);
  }
}
