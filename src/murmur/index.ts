/**
 * Murmur — orchestration trigger system.
 *
 * Entry point for murmur state management and trigger evaluation.
 */

export { MurmurStateManager } from "./state-manager.js";
export type { MurmurState, MurmurStateManagerOptions } from "./state-manager.js";

export { evaluateTriggers } from "./trigger-evaluator.js";
export type { TriggerResult, TaskStats } from "./trigger-evaluator.js";

export { buildReviewContext } from "./context-builder.js";
export type { ContextBuilderOptions } from "./context-builder.js";
