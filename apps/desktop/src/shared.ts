import type {
  AgentPublicOutputEvent,
  AuditHistoryPage,
  RecoveryDecision,
  RunInspection,
  TextArtifactView
} from "@nexora/harness";

export type DesktopSessionSummary = {
  readonly id: string;
  readonly title: string;
  readonly status: RunInspection["status"];
  readonly pendingRequestKind: "input" | "approval" | null;
  readonly archived: boolean;
  readonly updatedAt: string;
};

export type ProjectView = {
  readonly path: string;
  readonly name: string;
  readonly sessions: readonly DesktopSessionSummary[];
};

export type ModelProfileView = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKeyConfigured: boolean;
  readonly model: string;
  readonly contextWindowTokens: number | null;
  readonly decisionOutputTokens: number;
  readonly transport: "native_tools" | "structured_output";
};

export type ModelProfileInput = {
  readonly id?: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly decisionOutputTokens: number;
  readonly transport: "native_tools" | "structured_output";
};

export type WorkspaceView = {
  readonly path: string;
  readonly name: string;
  readonly providerConfigured: boolean;
  readonly providerError: string | null;
  readonly model: string | null;
  readonly projects: readonly ProjectView[];
  readonly modelProfiles: readonly ModelProfileView[];
  readonly selectedModelProfileId: string | null;
};

export type SessionRunView = {
  readonly userInput: string;
  readonly inspection: RunInspection;
  readonly history: AuditHistoryPage;
};

export type SessionView = {
  readonly id: string;
  readonly title: string;
  readonly runs: readonly SessionRunView[];
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
  switchProject(path: string): Promise<DesktopSnapshot>;
  startSession(goal: string): Promise<DesktopSnapshot>;
  continueSession(sessionId: string, text: string): Promise<DesktopSnapshot>;
  openSession(projectPath: string, sessionId: string): Promise<DesktopSnapshot>;
  archiveSession(sessionId: string, archived: boolean): Promise<DesktopSnapshot>;
  removeSession(sessionId: string): Promise<DesktopSnapshot>;
  saveModelProfile(profile: ModelProfileInput): Promise<DesktopSnapshot>;
  deleteModelProfile(profileId: string): Promise<DesktopSnapshot>;
  selectModelProfile(profileId: string): Promise<DesktopSnapshot>;
  control(runId: string, control: SessionControl): Promise<void>;
  readArtifact(digest: string): Promise<TextArtifactView>;
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
  onError(listener: (message: string) => void): () => void;
  onPublicOutput(listener: (event: AgentPublicOutputEvent) => void): () => void;
};
