import type {
  AuditHistoryPage,
  RecoveryDecision,
  RunInspection,
  RunSummary,
  TextArtifactView
} from "@nexora/harness";

export type WorkspaceView = {
  readonly path: string;
  readonly name: string;
  readonly providerConfigured: boolean;
  readonly model: string | null;
  readonly sessions: readonly RunSummary[];
};

export type SessionView = {
  readonly inspection: RunInspection;
  readonly history: AuditHistoryPage;
};

export type DesktopSnapshot = {
  readonly workspace: WorkspaceView;
  readonly session: SessionView | null;
};

export type SessionControl =
  | { readonly type: "input"; readonly text: string; readonly requestId: string }
  | { readonly type: "approve"; readonly requestId: string }
  | { readonly type: "deny"; readonly requestId: string; readonly reason?: string }
  | { readonly type: "cancel" }
  | { readonly type: "resume" }
  | { readonly type: "extend_budget" }
  | { readonly type: "recover"; readonly recovery: RecoveryDecision };

export type DesktopBridge = {
  bootstrap(): Promise<DesktopSnapshot>;
  chooseWorkspace(): Promise<DesktopSnapshot | null>;
  startSession(goal: string): Promise<DesktopSnapshot>;
  openSession(runId: string): Promise<DesktopSnapshot>;
  control(runId: string, control: SessionControl): Promise<void>;
  readArtifact(digest: string): Promise<TextArtifactView>;
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
  onError(listener: (message: string) => void): () => void;
};
