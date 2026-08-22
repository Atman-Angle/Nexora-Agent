import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DesktopSnapshot, ProviderSettingsInput, SessionControl } from "./shared.js";

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};

export class RuntimeWorkerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #onSnapshot: (snapshot: DesktopSnapshot) => void;
  readonly #onError: (message: string) => void;
  #sequence = 0;
  #closed = false;

  constructor(input: {
    readonly workspace: string;
    readonly onSnapshot: (snapshot: DesktopSnapshot) => void;
    readonly onError: (message: string) => void;
  }) {
    this.#onSnapshot = input.onSnapshot;
    this.#onError = input.onError;
    const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "runtime-worker.js");
    this.#child = spawn("node", [workerPath, input.workspace], {
      cwd: input.workspace,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    createInterface({ input: this.#child.stdout, crlfDelay: Infinity }).on("line", (line) => this.#receive(line));
    createInterface({ input: this.#child.stderr, crlfDelay: Infinity }).on("line", (line) => this.#onError(line));
    this.#child.on("error", (error) => this.#failAll(error));
    this.#child.on("exit", (code) => {
      if (!this.#closed) this.#failAll(new Error(`Desktop Runtime worker exited with code ${code ?? "unknown"}.`));
    });
  }

  snapshot(): Promise<DesktopSnapshot> { return this.#invoke("snapshot") as Promise<DesktopSnapshot>; }
  setWorkspace(path: string): Promise<DesktopSnapshot> { return this.#invoke("setWorkspace", path) as Promise<DesktopSnapshot>; }
  startSession(goal: string): Promise<DesktopSnapshot> { return this.#invoke("startSession", goal) as Promise<DesktopSnapshot>; }
  continueSession(sessionId: string, text: string): Promise<DesktopSnapshot> { return this.#invoke("continueSession", sessionId, text) as Promise<DesktopSnapshot>; }
  openSession(projectPath: string, sessionId: string): Promise<DesktopSnapshot> { return this.#invoke("openSession", projectPath, sessionId) as Promise<DesktopSnapshot>; }
  archiveSession(sessionId: string, archived: boolean): Promise<DesktopSnapshot> { return this.#invoke("archiveSession", sessionId, archived) as Promise<DesktopSnapshot>; }
  removeSession(sessionId: string): Promise<DesktopSnapshot> { return this.#invoke("removeSession", sessionId) as Promise<DesktopSnapshot>; }
  saveProviderSettings(settings: ProviderSettingsInput): Promise<DesktopSnapshot> { return this.#invoke("saveProviderSettings", settings) as Promise<DesktopSnapshot>; }
  async control(runId: string, control: SessionControl): Promise<void> { await this.#invoke("control", runId, control); }
  readArtifact(digest: string): Promise<unknown> { return this.#invoke("readArtifact", digest); }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.#invoke("close"); }
    catch { this.#child.kill(); }
  }

  #invoke(method: string, ...args: unknown[]): Promise<unknown> {
    if (this.#child.exitCode !== null) return Promise.reject(new Error("Desktop Runtime worker is not running."));
    this.#sequence += 1;
    const id = this.#sequence;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    });
    this.#child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
    return promise;
  }

  #receive(line: string): void {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; }
    catch { this.#onError(`Invalid Desktop Runtime worker output: ${line}`); return; }
    if (value.type === "snapshot") {
      this.#onSnapshot(value.snapshot as DesktopSnapshot);
      return;
    }
    if (value.type === "runtime-error") {
      this.#onError(String(value.message));
      return;
    }
    if (value.type !== "response" || typeof value.id !== "number") return;
    const pending = this.#pending.get(value.id);
    if (pending === undefined) return;
    this.#pending.delete(value.id);
    if (typeof value.error === "string") pending.reject(new Error(value.error));
    else pending.resolve(value.result);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#onError(error.message);
  }
}
