import type { AgentProfile } from "../profile/types.js";

export type AgentDeployment = { readonly name: string; readonly version: string; readonly profile: AgentProfile };

/** Immutable cold-path registry; it does not execute, persist, or mutate Runs. */
export class InProcessAgentRegistry {
  private readonly entries: ReadonlyMap<string, AgentDeployment>;
  public constructor(deployments: readonly AgentDeployment[]) {
    const entries = new Map<string, AgentDeployment>();
    for (const deployment of deployments) {
      if (!deployment.name.trim() || !deployment.version.trim()) throw new Error("Agent deployment name and version must be non-empty.");
      if (deployment.profile.name !== deployment.name) throw new Error(`Deployment ${deployment.name} must match AgentProfile.name.`);
      if (entries.has(deployment.name)) throw new Error(`Duplicate agent deployment: ${deployment.name}.`);
      entries.set(deployment.name, Object.freeze({ ...deployment }));
    }
    this.entries = entries;
  }
  public resolve(name: string): AgentDeployment | undefined { return this.entries.get(name); }
  public list(): AgentDeployment[] { return [...this.entries.values()]; }
}
