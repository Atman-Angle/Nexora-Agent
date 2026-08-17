import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
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

  temporaryPath(label = "payload"): string {
    return join(this.#root, `.${label}.${randomUUID()}.tmp`);
  }

  async putFile(temporaryPath: string, mediaType = "application/octet-stream"): Promise<ArtifactReference> {
    const hash = createHash("sha256");
    let byteLength = 0;
    for await (const chunk of createReadStream(temporaryPath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      byteLength += bytes.byteLength;
    }
    const hex = hash.digest("hex");
    const digest = `sha256:${hex}`;
    const path = join(this.#root, hex);
    if (existsSync(path)) await rm(temporaryPath, { force: true });
    else {
      try {
        await rename(temporaryPath, path);
      } catch (error) {
        if (existsSync(path)) {
          await rm(temporaryPath, { force: true });
          return { digest, mediaType, byteLength, path };
        }
        await rm(temporaryPath, { force: true });
        throw error;
      }
    }
    return { digest, mediaType, byteLength, path };
  }

  getText(digest: string): string {
    const content = readFileSync(this.#pathForDigest(digest));
    const actual = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (actual !== digest) throw new Error(`Artifact digest mismatch: ${digest}`);
    return content.toString("utf8");
  }

  has(digest: string): boolean {
    return existsSync(this.#pathForDigest(digest));
  }

  verify(digest: string): boolean {
    try {
      this.getText(digest);
      return true;
    } catch {
      return false;
    }
  }

  #pathForDigest(digest: string): string {
    const match = /^sha256:([a-f0-9]{64})$/.exec(digest);
    if (match === null) throw new Error(`Invalid Artifact digest: ${digest}`);
    const hash = match[1];
    if (hash === undefined) throw new Error(`Invalid Artifact digest: ${digest}`);
    return join(this.#root, hash);
  }
}
