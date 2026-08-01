import {
  createBuiltInTools,
  createRuntime,
  type PublicPendingRequest,
  type RunFinalResult,
  type RunInspection,
  type RuntimeEvent,
  type RuntimeProvider
} from "@nexora/runtime";

export type RuntimeWorkerOptions = {
  readonly workspace: string;
  readonly input: string;
  readonly provider: RuntimeProvider;
  readonly approve: (
    request: Extract<
      PublicPendingRequest,
      { readonly kind: "approval" }
    >
  ) => boolean | Promise<boolean>;
};

export type RuntimeWorkerOutcome = {
  readonly result: RunFinalResult;
  readonly inspection: RunInspection;
  readonly events: readonly RuntimeEvent[];
};

export async function runRuntimeWorker(
  options: RuntimeWorkerOptions
): Promise<RuntimeWorkerOutcome> {
  const runtime = createRuntime({
    workspace: options.workspace,
    provider: options.provider,
    tools: createBuiltInTools()
  });
  const run = runtime.run(options.input);
  const events: RuntimeEvent[] = [];
  const subscription = run.subscribe(async (event) => {
    events.push(event);
    if (event.type !== "approval.required") return;
    if (await options.approve(event.request)) {
      await run.approve({ requestId: event.request.id });
    } else {
      await run.deny({
        requestId: event.request.id,
        reason: "The Worker host denied this mutation."
      });
    }
  });

  try {
    await subscription.closed;
    const result = await run.result();
    return {
      result,
      inspection: await run.inspect(),
      events
    };
  } finally {
    await subscription.close();
    await runtime.close();
  }
}
