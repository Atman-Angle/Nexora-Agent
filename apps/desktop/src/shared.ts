import type {
  AgentPublicOutputEvent,
  AuditHistoryPage,
  RecoveryDecision,
  RuntimeBudgetExtension,
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
  readonly activeInputTargetTokens: number | null;
  readonly decisionOutputTokens: number;
  readonly transport: "native_tools" | "structured_output";
  readonly reasoning: "off" | "dynamic" | "on";
  readonly thinkingToggleParam: string | null;
};

export type ModelProfileInput = {
  readonly id?: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly activeInputTargetTokens?: number | null;
  readonly decisionOutputTokens: number;
  readonly transport: "native_tools" | "structured_output";
  readonly reasoning?: "off" | "dynamic" | "on";
  readonly thinkingToggleParam?: string | null;
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

export type AttachmentView = {
  readonly id: string;
  readonly name: string;
  readonly workspacePath: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly kind: "office" | "image" | "pdf";
  readonly source?: {
    readonly kind: "folder";
    readonly id: string;
    readonly name: string;
    readonly fileCount: number;
    readonly totalBytes: number;
  };
};

export type DesktopMessageInput = {
  readonly text: string;
  readonly attachments: readonly AttachmentView[];
};

export type SessionRunView = {
  readonly userInput: string;
  readonly attachments: readonly AttachmentView[];
  readonly inspection: RunInspection;
  readonly history: AuditHistoryPage;
  readonly publicOutputs: readonly PersistedPublicOutput[];
};

export type PersistedPublicOutput = {
  readonly key: string;
  readonly runId: string;
  readonly modelCallId: string;
  readonly attemptId: string;
  readonly occurredAt: string;
  readonly reasoning: string;
  readonly content: string;
};

export type SessionView = {
  readonly id: string;
  readonly title: string;
  readonly runs: readonly SessionRunView[];
  readonly inspection: RunInspection;
  readonly history: AuditHistoryPage;
  readonly managedProcesses: readonly ManagedProcessView[];
  readonly deliverables: readonly DeliverableSummary[];
};

export type DeliverableSummary = {
  readonly deliverableId: string;
  readonly kind: "rich_document";
  readonly title: string;
  readonly manifestPath: string;
  readonly previewPath: string;
  readonly revision: number;
  readonly sourceDigest: string;
  readonly previewDigest: string;
  readonly files: readonly {
    readonly format: "docx" | "xlsx" | "pptx" | "pdf";
    readonly path: string;
    readonly digest: string;
    readonly byteLength: number;
  }[];
  readonly validation: "passed" | "unavailable";
  readonly stage: "created" | "imported" | "modified" | "exported";
  readonly sourceRunId: string;
  readonly changedBlockIds: readonly string[];
  readonly preservedBlockCount: number;
};

export type DeliverablePreview = {
  readonly deliverableId: string;
  readonly title: string;
  readonly revision: number;
  readonly sourceDigest: string;
  readonly previewDigest: string;
  readonly html: string;
};

export type ManagedProcessView = {
  readonly processHandle: string;
  readonly serviceKey: string;
  readonly status: "starting" | "ready" | "stopping" | "exited" | "failed" | "lost";
  readonly pid: number | null;
  readonly startedAt: string;
  readonly readyAt: string | null;
  readonly stoppedAt: string | null;
  readonly endpoint: string | null;
  readonly exitCode: number | null;
  readonly errorCode: string | null;
  readonly heartbeatFresh: boolean;
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
  | { readonly type: "extend_budget"; readonly budgetExtension: RuntimeBudgetExtension }
  | { readonly type: "worker_resume"; readonly branchId: string; readonly childRunId: string }
  | { readonly type: "worker_discard"; readonly branchId: string }
  | { readonly type: "recover"; readonly recovery: RecoveryDecision };

export type DesktopBridge = {
  bootstrap(): Promise<DesktopSnapshot>;
  chooseWorkspace(): Promise<DesktopSnapshot | null>;
  chooseAttachments(): Promise<readonly AttachmentView[]>;
  chooseAttachmentFolder(): Promise<readonly AttachmentView[]>;
  stageDroppedAttachments(files: readonly File[]): Promise<readonly AttachmentView[]>;
  addProject(path: string): Promise<DesktopSnapshot>;
  removeProject(path: string): Promise<DesktopSnapshot>;
  switchProject(path: string): Promise<DesktopSnapshot>;
  startSession(input: DesktopMessageInput): Promise<DesktopSnapshot>;
  continueSession(sessionId: string, input: DesktopMessageInput): Promise<DesktopSnapshot>;
  compactSession(sessionId: string): Promise<DesktopSnapshot>;
  openSession(projectPath: string, sessionId: string): Promise<DesktopSnapshot>;
  archiveSession(projectPath: string, sessionId: string, archived: boolean): Promise<DesktopSnapshot>;
  removeSession(projectPath: string, sessionId: string): Promise<DesktopSnapshot>;
  saveModelProfile(profile: ModelProfileInput): Promise<DesktopSnapshot>;
  deleteModelProfile(profileId: string): Promise<DesktopSnapshot>;
  selectModelProfile(profileId: string): Promise<DesktopSnapshot>;
  setSelectedModelReasoning(reasoning: "off" | "dynamic" | "on"): Promise<DesktopSnapshot>;
  control(runId: string, control: SessionControl): Promise<void>;
  readArtifact(digest: string): Promise<TextArtifactView>;
  readDeliverable(projectPath: string, manifestPath: string, expectedRevision: number, expectedPreviewDigest: string): Promise<DeliverablePreview>;
  openWorkspaceEntry(projectPath: string, entryPath: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
  onError(listener: (message: string) => void): () => void;
  onPublicOutput(listener: (event: AgentPublicOutputEvent) => void): () => void;
};
