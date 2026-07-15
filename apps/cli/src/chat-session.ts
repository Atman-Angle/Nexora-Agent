import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { openDatabase, SessionMemoryStore } from "../../../packages/storage/src/index.js";
import { extractDirectStableFactIntents } from "./verified-fact-intent.js";
import type { SelectionHandle } from "../../../packages/contracts/src/index.js";

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

export type ChatSessionResponse = {
  text: string;
  selectionPaths?: readonly string[];
};

export function openChatSessionStore(databasePath: string): { store: SessionMemoryStore; close: () => void } {
  const database = openDatabase(databasePath);
  return { store: new SessionMemoryStore(database), close: () => database.close() };
}

export function buildChatPrompt(history: readonly ChatMessage[], userText: string, facts: readonly { key: string; value: string; status: string }[] = [], handles: readonly SelectionHandle[] = []): string {
  const transcript = history
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
    .join("\n");
  return [
    "Continue the following Nexora chat session. Use the available workspace tools (filesystem.read, filesystem.search, filesystem.list, project.inspect, git.*) to ground your answer in the real repository; do not fabricate file contents you did not read. To modify a file, use filesystem.patch — it will request approval, it will not auto-execute.",
    "Treat the latest User line as a request: read a named workspace-relative file before answering about it, search when asked to locate content, and ask a concise clarification only when no path, search terms, or active result handle can ground the request.",
    ...(facts.length === 0 ? [] : ["Verified user facts (active facts are reliable; pending conflicts must not be resolved until user confirmation):", ...facts.map((fact) => `${fact.status}: ${fact.key} = ${fact.value}`)]),
    ...(handles.length === 0 ? [] : ["Active search-result handles (session scoped; use only these exact paths for ordinal references):", ...handles.map((handle) => `result ${handle.position}: ${handle.path}`)]),
    ...(transcript.length === 0 ? [] : [transcript]),
    `User: ${userText}`,
    "Assistant:"
  ].join("\n");
}

export async function runChatSession(input: {
  ask: (prompt: string, runtimeContext?: unknown) => Promise<ChatSessionResponse>;
  initialText?: string;
  input: Readable;
  output: Writable & { isTTY?: boolean };
  session?: { id: string; store: SessionMemoryStore; now?: () => string };
}): Promise<void> {
  const now = input.session?.now ?? (() => new Date().toISOString());
  if (input.session !== undefined && input.session.store.getSession(input.session.id) === undefined) {
    const createdAt = now();
    input.session.store.insertSession({ sessionId: input.session.id, profile: "chat", createdAt, updatedAt: createdAt });
  }
  const history: ChatMessage[] = [];
  let ordinal = input.session === undefined ? 0 : (input.session.store.listTurns(input.session.id).at(-1)?.ordinal ?? -1) + 1;
  const readline = createInterface({ input: input.input, output: input.output, terminal: input.output.isTTY === true });

  const respond = async (text: string): Promise<void> => {
    const notices: string[] = [];
    const priorHistory: ChatMessage[] = input.session === undefined
      ? history
      : input.session.store.selectTurnsForContext(input.session.id, 4_096).map(({ role, text }) => ({ role, text }));
    let sourceTurnId: string | undefined;
    if (input.session !== undefined) {
      const turnId = randomUUID();
      sourceTurnId = turnId;
      const createdAt = now();
      input.session.store.appendTurn({ turnId, sessionId: input.session.id, ordinal, role: "user", text, createdAt });
      ordinal += 1;
      for (const intent of extractDirectStableFactIntents(text)) {
        const write = input.session.store.writeDirectUserFact({ factId: randomUUID(), ...intent, sourceTurnId: turnId, createdAt });
        if (write.fact.status === "pending_confirmation") notices.push(`Memory conflict: ${write.fact.key} is awaiting confirmation (${write.fact.factId}). Use /confirm ${write.fact.factId} or /forget ${write.fact.factId}.`);
        if (write.noticeSensitive) notices.push(`Saved sensitive memory ${write.fact.key}. Say /forget ${write.fact.factId} to remove it or state a corrected value to modify it.`);
      }
    }
    const facts = input.session === undefined ? [] : input.session.store.listFacts().filter((fact) => fact.status === "active" || fact.status === "pending_confirmation");
    const handles = input.session === undefined ? [] : input.session.store.listSelectionHandles(input.session.id);
    const response = await input.ask(buildChatPrompt(priorHistory, text, facts, handles), { conversation: priorHistory, memory: facts, selectionHandles: handles, selectionRequestText: text });
    const answer = response.text;
    if (input.session === undefined) history.push({ role: "user", text }, { role: "assistant", text: answer });
    if (input.session !== undefined) {
      if (response.selectionPaths !== undefined && sourceTurnId !== undefined) {
        input.session.store.replaceSelectionHandles({ sessionId: input.session.id, sourceTurnId, paths: response.selectionPaths, now: now(), idGenerator: randomUUID });
      }
      input.session.store.appendTurn({ turnId: randomUUID(), sessionId: input.session.id, ordinal, role: "assistant", text: answer, createdAt: now() });
      ordinal += 1;
    }
    input.output.write(`${answer}\n${notices.length === 0 ? "" : `${notices.join("\n")}\n`}`);
  };

  try {
    if (input.initialText !== undefined) {
      await respond(input.initialText);
    }

    while (true) {
      let line: string;
      try {
        line = await readline.question("nexora> ");
      } catch {
        return;
      }
      const text = line.trim();
      if (text === "/exit" || text === "/quit" || text === "exit" || text === "quit") {
        return;
      }
      if (input.session !== undefined && text.startsWith("/confirm ")) {
        const factId = text.slice("/confirm ".length).trim();
        const fact = input.session.store.confirmPendingFact(factId, now());
        input.output.write(fact === undefined ? "No pending memory found.\n" : `Memory confirmed: ${fact.key} = ${fact.value}\n`);
        continue;
      }
      if (input.session !== undefined && text.startsWith("/forget ")) {
        const factId = text.slice("/forget ".length).trim();
        const changed = input.session.store.retractFact(factId, now());
        input.output.write(changed ? "Memory forgotten.\n" : "No active or pending memory found.\n");
        continue;
      }
      if (input.session !== undefined && text === "/memory") {
        const facts = input.session.store.listFacts().filter((fact) => fact.status === "active" || fact.status === "pending_confirmation");
        input.output.write(`${facts.length === 0 ? "No stored memory." : facts.map((fact) => `${fact.factId} ${fact.status} ${fact.key} = ${fact.value}`).join("\n")}\n`);
        continue;
      }
      if (text.length > 0) {
        await respond(text);
      }
    }
  } finally {
    readline.close();
  }
}
