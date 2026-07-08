import {
  BuilderStateSchema,
  StrategyDecisionSchema,
  StrategyStateSchema,
  type BuilderState,
  type StrategyDecision,
  type StrategyState
} from "../../../contracts/src/index.js";
import { z } from "zod";
import type { AgentLoopState } from "../agent-loop/state.js";

/**
 * CodingProfileState — the coding profile's owned domain state, migrated out
 * of the top-level AgentLoopState (F029). The runtime holds this as an opaque
 * `unknown` blob (`state.profileState`); the coding profile casts internally.
 */
export type CodingProfileState = {
  strategy: StrategyState;
  builder: BuilderState;
  /** Transient; serialized for symmetry but unused on restore. */
  strategyDecision: StrategyDecision;
  finalizationPlanRejectionCount: number;
  validationRepairActionRejectionCount: number;
};

export const CodingProfileStateSchema = z.object({
  strategy: StrategyStateSchema,
  builder: BuilderStateSchema,
  strategyDecision: StrategyDecisionSchema,
  finalizationPlanRejectionCount: z.number().int().nonnegative(),
  validationRepairActionRejectionCount: z.number().int().nonnegative()
});

/**
 * parseCodingProfileState — Zod guard used by readCodingState/restoreState to
 * validate the opaque profileState blob. Throws (ZodError) on bad shape; the
 * caller wraps into ProfileStateInvalidError where appropriate.
 */
export function parseCodingProfileState(input: unknown): CodingProfileState {
  return CodingProfileStateSchema.parse(input);
}

/**
 * readCodingState — the single read accessor coding handlers/adapters use to
 * reach the migrated strategy/builder/counter fields. Casts the opaque
 * `state.profileState` blob to CodingProfileState and Zod-validates it.
 *
 * Lives in this module (not coding-profile.ts) to avoid a circular import:
 * policies need readCodingState/writeCodingState, and coding-profile.ts
 * imports the policies. Keeping the accessors here means policies → this
 * module → agent-loop/state.js, with no back-edge into coding-profile.ts.
 */
export function readCodingState(state: AgentLoopState): CodingProfileState {
  return parseCodingProfileState(state.profileState);
}

/**
 * writeCodingState — apply a pure mutator to the current CodingProfileState and
 * return the new state value for `Object.assign(state, { profileState })` or a
 * policy stateDelta. Centralizes the rebuild so no site writes a migrated
 * top-level field directly.
 */
export function writeCodingState(
  state: AgentLoopState,
  mutator: (current: CodingProfileState) => CodingProfileState
): CodingProfileState {
  return mutator(readCodingState(state));
}

