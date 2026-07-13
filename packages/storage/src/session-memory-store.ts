import {
  ConversationSessionSchema,
  ConversationTurnSchema,
  DirectUserFactWriteSchema,
  UserFactSchema,
  type ConversationSession,
  type ConversationTurn,
  type DirectUserFactWrite,
  type SelectionHandle,
  SelectionHandleSchema,
  type UserFact
} from "../../contracts/src/index.js";
import type { DatabaseClient } from "./database.js";

export class SessionMemoryStore {
  public constructor(private readonly database: DatabaseClient) {}
  public insertSession(value: ConversationSession): void {
    const v = ConversationSessionSchema.parse(value);
    this.database.connection.prepare("INSERT INTO chat_sessions (id,profile,created_at,updated_at) VALUES (@sessionId,@profile,@createdAt,@updatedAt)").run(v);
  }

  public getSession(sessionId: string): ConversationSession | undefined {
    const row = this.database.connection.prepare("SELECT id, profile, created_at, updated_at FROM chat_sessions WHERE id = ?").get(sessionId) as Row | undefined;
    return row === undefined ? undefined : session(row);
  }

  public listSessions(): ConversationSession[] {
    return (this.database.connection.prepare("SELECT id, profile, created_at, updated_at FROM chat_sessions ORDER BY updated_at DESC, id DESC").all() as Row[]).map(session);
  }

  public appendTurn(value: ConversationTurn): void {
    const v = ConversationTurnSchema.parse(value);
    const write = this.database.connection.transaction(() => {
      this.database.connection.prepare("INSERT INTO chat_turns (id,session_id,ordinal,role,text,created_at) VALUES (@turnId,@sessionId,@ordinal,@role,@text,@createdAt)").run(v);
      this.database.connection.prepare("UPDATE chat_sessions SET updated_at=@createdAt WHERE id=@sessionId").run(v);
    });
    write();
  }

  public listTurns(sessionId: string): ConversationTurn[] {
    return (this.database.connection.prepare("SELECT id,session_id,ordinal,role,text,created_at FROM chat_turns WHERE session_id=? ORDER BY ordinal").all(sessionId) as Row[]).map(turn);
  }

  /** Loads only the selected recent source bodies; older turns stay durable but cold. */
  public listRecentTurns(sessionId: string, limit: number): ConversationTurn[] {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("Recent turn limit must be a positive integer.");
    return (this.database.connection.prepare("SELECT id,session_id,ordinal,role,text,created_at FROM chat_turns WHERE session_id=? ORDER BY ordinal DESC LIMIT ?").all(sessionId, limit) as Row[]).reverse().map(turn);
  }

  /**
   * Metadata-first conversation selection. SQLite reads only ids, ordinals and
   * lengths for the cold history; bodies are fetched after deterministic
   * recency admission. This is the hot-path fallback token estimator.
   */
  public selectTurnsForContext(sessionId: string, tokenBudget: number): ConversationTurn[] {
    if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) throw new Error("Conversation token budget must be a positive integer.");
    const metadata = this.database.connection.prepare("SELECT id, ordinal, length(text) AS character_count FROM chat_turns WHERE session_id = ? ORDER BY ordinal DESC").all(sessionId) as Row[];
    const selectedIds: string[] = [];
    let usedTokens = 0;
    for (const row of metadata) {
      const estimatedTokens = Math.ceil(Number(row.character_count) / 4);
      if (selectedIds.length > 0 && usedTokens + estimatedTokens > tokenBudget) break;
      selectedIds.push(String(row.id));
      usedTokens += estimatedTokens;
    }
    if (selectedIds.length === 0) return [];
    const placeholders = selectedIds.map(() => "?").join(",");
    return (this.database.connection.prepare(`SELECT id,session_id,ordinal,role,text,created_at FROM chat_turns WHERE session_id = ? AND id IN (${placeholders}) ORDER BY ordinal`).all(sessionId, ...selectedIds) as Row[]).map(turn);
  }

  public deleteSession(sessionId: string): boolean {
    return this.database.connection.prepare("DELETE FROM chat_sessions WHERE id=?").run(sessionId).changes > 0;
  }

  public clearSession(sessionId: string, updatedAt: string): boolean {
    const clear = this.database.connection.transaction(() => {
      const changed = this.database.connection.prepare("DELETE FROM chat_turns WHERE session_id = ?").run(sessionId).changes;
      this.database.connection.prepare("DELETE FROM chat_selection_handles WHERE session_id = ?").run(sessionId);
      if (changed > 0) this.database.connection.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(updatedAt, sessionId);
      return changed > 0;
    });
    return clear();
  }

  /** Replaces the bounded, session-scoped result-list projection with one real search result. */
  public replaceSelectionHandles(input: {
    sessionId: string;
    sourceTurnId: string;
    paths: readonly string[];
    now: string;
    idGenerator: () => string;
  }): SelectionHandle[] {
    const paths = [...new Set(input.paths)].slice(0, 20);
    const handles = paths.map((path, index) => SelectionHandleSchema.parse({
      handleId: input.idGenerator(), sessionId: input.sessionId, sourceTurnId: input.sourceTurnId,
      position: index + 1, path, createdAt: input.now
    }));
    const write = this.database.connection.transaction(() => {
      this.database.connection.prepare("DELETE FROM chat_selection_handles WHERE session_id = ?").run(input.sessionId);
      const insert = this.database.connection.prepare("INSERT INTO chat_selection_handles (id,session_id,source_turn_id,position,path,created_at) VALUES (@handleId,@sessionId,@sourceTurnId,@position,@path,@createdAt)");
      for (const handle of handles) insert.run(handle);
    });
    write();
    return handles;
  }

  public listSelectionHandles(sessionId: string): SelectionHandle[] {
    return (this.database.connection.prepare("SELECT id,session_id,source_turn_id,position,path,created_at FROM chat_selection_handles WHERE session_id = ? ORDER BY position").all(sessionId) as Row[])
      .map((row) => SelectionHandleSchema.parse({ handleId: row.id, sessionId: row.session_id, sourceTurnId: row.source_turn_id, position: row.position, path: row.path, createdAt: row.created_at }));
  }

  public clearAllSessions(): number {
    return this.database.connection.prepare("DELETE FROM chat_sessions").run().changes;
  }

  /** Only the trusted direct-user input path can create a fact. */
  public writeDirectUserFact(value: DirectUserFactWrite): { fact: UserFact; noticeSensitive: boolean } {
    const input = DirectUserFactWriteSchema.parse(value);
    const write = this.database.connection.transaction(() => {
      const active = this.findActiveFact(input.key);
      if (active?.value === input.value) return { fact: active, noticeSensitive: false };
      const now = input.createdAt;
      const fact = UserFactSchema.parse({ ...input, status: active === undefined ? "active" : "pending_confirmation", updatedAt: now });
      this.database.connection.prepare("INSERT INTO user_facts (id,key,value,source_turn_id,sensitive,status,created_at,updated_at) VALUES (@factId,@key,@value,@sourceTurnId,@sensitive,@status,@createdAt,@updatedAt)").run({ ...fact, sensitive: fact.sensitive ? 1 : 0 });
      return { fact, noticeSensitive: fact.sensitive && active === undefined };
    });
    return write();
  }

  public listFacts(status?: UserFact["status"]): UserFact[] {
    const rows = status === undefined
      ? this.database.connection.prepare("SELECT id,key,value,source_turn_id,sensitive,status,created_at,updated_at FROM user_facts ORDER BY updated_at DESC, id DESC").all()
      : this.database.connection.prepare("SELECT id,key,value,source_turn_id,sensitive,status,created_at,updated_at FROM user_facts WHERE status = ? ORDER BY updated_at DESC, id DESC").all(status);
    return (rows as Row[]).map(fact);
  }

  public findActiveFact(key: string): UserFact | undefined {
    const row = this.database.connection.prepare("SELECT id,key,value,source_turn_id,sensitive,status,created_at,updated_at FROM user_facts WHERE key = ? AND status = 'active' ORDER BY updated_at DESC, id DESC LIMIT 1").get(key) as Row | undefined;
    return row === undefined ? undefined : fact(row);
  }

  public confirmPendingFact(factId: string, updatedAt: string): UserFact | undefined {
    const confirm = this.database.connection.transaction(() => {
      const pendingRow = this.database.connection.prepare("SELECT id,key,value,source_turn_id,sensitive,status,created_at,updated_at FROM user_facts WHERE id = ? AND status = 'pending_confirmation'").get(factId) as Row | undefined;
      if (pendingRow === undefined) return undefined;
      const pending = fact(pendingRow);
      this.database.connection.prepare("UPDATE user_facts SET status = 'superseded', updated_at = ? WHERE key = ? AND status = 'active'").run(updatedAt, pending.key);
      this.database.connection.prepare("UPDATE user_facts SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending_confirmation'").run(updatedAt, factId);
      return { ...pending, status: "active" as const, updatedAt };
    });
    return confirm();
  }

  public retractFact(factId: string, updatedAt: string): boolean {
    return this.database.connection.prepare("UPDATE user_facts SET status = 'retracted', updated_at = ? WHERE id = ? AND status IN ('active', 'pending_confirmation')").run(updatedAt, factId).changes > 0;
  }
}

type Row = Record<string, unknown>;
function session(row: Row): ConversationSession { return ConversationSessionSchema.parse({ sessionId: row.id, profile: row.profile, createdAt: row.created_at, updatedAt: row.updated_at }); }
function turn(row: Row): ConversationTurn { return ConversationTurnSchema.parse({ turnId: row.id, sessionId: row.session_id, ordinal: row.ordinal, role: row.role, text: row.text, createdAt: row.created_at }); }
function fact(row: Row): UserFact { return UserFactSchema.parse({ factId: row.id, key: row.key, value: row.value, sourceTurnId: row.source_turn_id, sensitive: Number(row.sensitive) === 1, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }); }
