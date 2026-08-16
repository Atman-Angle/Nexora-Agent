import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";

import {
  RunControlError,
  RuntimeError,
  type RecoveryDecision,
  type RuntimeEngine,
  type RuntimeSubscription
} from "@nexora/harness";

export type RuntimeHttpHost = {
  listen(input?: {
    readonly port?: number;
    readonly hostname?: string;
  }): Promise<{ readonly port: number; readonly hostname: string }>;
  close(): Promise<void>;
};

export function createRuntimeHttpHost(input: {
  readonly runtime: RuntimeEngine;
  readonly maxBodyBytes?: number;
}): RuntimeHttpHost {
  const maxBodyBytes = input.maxBodyBytes ?? 64 * 1024;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes must be a positive integer.");
  }
  const subscriptions = new Set<RuntimeSubscription>();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const server = createServer((request, response) => {
    void route(request, response, input.runtime, subscriptions, maxBodyBytes)
      .catch((error: unknown) => writeError(response, error));
  });

  return Object.freeze({
    async listen(options = {}) {
      if (closed) throw new Error("Runtime HTTP Host is closed.");
      if (server.listening) throw new Error("Runtime HTTP Host is already listening.");
      const port = options.port ?? 0;
      const hostname = options.hostname ?? "127.0.0.1";
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, hostname);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Runtime HTTP Host did not bind a TCP address.");
      }
      return { port: address.port, hostname };
    },
    close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      closePromise = closeHost(server, subscriptions, input.runtime);
      void closePromise.catch(() => undefined);
      return closePromise;
    }
  });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RuntimeEngine,
  subscriptions: Set<RuntimeSubscription>,
  maxBodyBytes: number
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://runtime.invalid");
  const segments = url.pathname.split("/").filter(Boolean);

  if (method === "POST" && segments.length === 1 && segments[0] === "runs") {
    const body = await readJson(request, maxBodyBytes);
    const run = runtime.run(requiredString(body, "input"));
    writeJson(response, 202, { runId: run.id });
    return;
  }

  if (segments.length < 2 || segments[0] !== "runs") {
    writeJson(response, 404, {
      error: { code: "ROUTE_NOT_FOUND", message: "Route not found." }
    });
    return;
  }

  const runId = decodeURIComponent(segments[1]!);
  const action = segments[2] ?? "";
  const run = runtime.openRun(runId);

  if (method === "GET" && action === "") {
    writeJson(response, 200, await run.inspect());
    return;
  }
  if (method === "GET" && action === "result") {
    const inspection = await run.inspect();
    if (inspection.result === null) {
      writeJson(response, 202, {
        status: inspection.status,
        result: null
      });
    } else {
      writeJson(response, 200, inspection.result);
    }
    return;
  }
  if (method === "GET" && action === "events") {
    streamEvents(request, response, run, subscriptions, url);
    return;
  }
  if (method === "POST" && action === "input") {
    const body = await readJson(request, maxBodyBytes);
    await run.input(requiredString(body, "text"), {
      requestId: requiredString(body, "requestId")
    });
    writeEmpty(response);
    return;
  }
  if (method === "POST" && action === "approval") {
    const body = await readJson(request, maxBodyBytes);
    const requestId = requiredString(body, "requestId");
    if (requiredBoolean(body, "approved")) {
      await run.approve({ requestId });
    } else {
      const reason = optionalString(body, "reason");
      await run.deny({
        requestId,
        ...(reason === undefined ? {} : { reason })
      });
    }
    writeEmpty(response);
    return;
  }
  if (method === "POST" && action === "cancel") {
    const body = await readJson(request, maxBodyBytes);
    await run.cancel(optionalString(body, "reason"));
    writeEmpty(response);
    return;
  }
  if (method === "POST" && action === "resume") {
    const body = await readJson(request, maxBodyBytes);
    const recovery = optionalRecovery(body.recovery);
    await run.resume(recovery === undefined ? {} : { recovery });
    writeEmpty(response);
    return;
  }

  writeJson(response, 404, {
    error: { code: "ROUTE_NOT_FOUND", message: "Route not found." }
  });
}

function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  run: ReturnType<RuntimeEngine["openRun"]>,
  subscriptions: Set<RuntimeSubscription>,
  url: URL
): void {
  const afterSequence = eventCursor(request, url);
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive"
  });
  response.flushHeaders();

  const subscription = run.subscribe((event) => {
    response.write(`id: ${event.sequence}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }, { afterSequence });
  subscriptions.add(subscription);

  const close = (): void => {
    void subscription.close();
  };
  response.once("close", close);
  void subscription.closed.then(
    () => {
      subscriptions.delete(subscription);
      response.off("close", close);
      if (!response.writableEnded) response.end();
    },
    () => {
      subscriptions.delete(subscription);
      response.off("close", close);
      response.destroy();
    }
  );
}

function eventCursor(request: IncomingMessage, url: URL): number {
  const header = request.headers["last-event-id"];
  const raw = url.searchParams.get("afterSequence")
    ?? (Array.isArray(header) ? header[0] : header)
    ?? "0";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpInputError("afterSequence must be a non-negative integer.");
  }
  return parsed;
}

async function readJson(
  request: IncomingMessage,
  maxBodyBytes: number
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBodyBytes) {
      throw new HttpInputError("Request body is too large.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpInputError("Request body must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpInputError("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requiredString(
  body: Record<string, unknown>,
  name: string
): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpInputError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(
  body: Record<string, unknown>,
  name: string
): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpInputError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredBoolean(
  body: Record<string, unknown>,
  name: string
): boolean {
  const value = body[name];
  if (typeof value !== "boolean") {
    throw new HttpInputError(`${name} must be a boolean.`);
  }
  return value;
}

function optionalRecovery(value: unknown): RecoveryDecision | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpInputError("recovery must be an object.");
  }
  const body = value as Record<string, unknown>;
  const invocationId = requiredString(body, "invocationId");
  const outcome = body.outcome;
  if (
    outcome !== "confirmed_succeeded"
    && outcome !== "confirmed_failed"
    && outcome !== "abandon_run"
  ) {
    throw new HttpInputError("recovery.outcome is invalid.");
  }
  const reason = optionalString(body, "reason");
  if (outcome === "confirmed_succeeded") {
    return {
      invocationId,
      outcome,
      subjectRef: requiredString(body, "subjectRef")
    };
  }
  return {
    invocationId,
    outcome,
    ...(reason === undefined ? {} : { reason })
  };
}

function writeEmpty(response: ServerResponse): void {
  if (response.headersSent) return;
  response.writeHead(204);
  response.end();
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  if (error instanceof HttpInputError) {
    writeJson(response, 400, {
      error: { code: "INVALID_INPUT", message: error.message }
    });
    return;
  }
  if (error instanceof RuntimeError) {
    const status = error.code === "RUN_NOT_FOUND"
      ? 404
      : error.code === "RUN_BUSY" || error.code === "RUN_STATE_CONFLICT"
        ? 409
        : error.code === "PROVIDER_UNAVAILABLE"
          ? 503
          : error.code === "RUNTIME_CLOSED"
            ? 410
            : error.code === "INVALID_CONFIGURATION"
              || error.code === "INVALID_INPUT"
              ? 400
              : 500;
    writeJson(response, status, {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...("runId" in error && error.runId !== undefined
          ? { runId: error.runId }
          : {}),
        ...(error instanceof RunControlError && error.requestId !== undefined
          ? { requestId: error.requestId }
          : {})
      }
    });
    return;
  }
  writeJson(response, 500, {
    error: {
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error)
    }
  });
}

async function closeHost(
  server: Server,
  subscriptions: Set<RuntimeSubscription>,
  runtime: RuntimeEngine
): Promise<void> {
  const serverClosed = new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  await Promise.all([...subscriptions].map(async (subscription) => {
    await subscription.close();
  }));
  await runtime.close();
  server.closeIdleConnections();
  server.closeAllConnections();
  await serverClosed;
}

class HttpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpInputError";
  }
}
