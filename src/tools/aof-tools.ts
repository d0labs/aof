/**
 * AOF Tools — Re-export hub for all AOF tool modules.
 * 
 * This file acts as a thin orchestrator, re-exporting tools from domain-specific modules:
 * - project-tools.ts: Task creation/dispatch
 * - query-tools.ts: Read-only queries and reports
 * - task-tools.ts: Task manipulation (update, complete, cancel, deps, block)
 */

import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";

/**
 * Shared context passed to every AOF tool function, providing access to
 * the task store, event logger, and optional project scope.
 */
export interface ToolContext {
  /** The task store used for all CRUD and state-transition operations. */
  store: ITaskStore;
  /** Event logger for recording audit events and triggering notifications. */
  logger: EventLogger;
  /** Project ID for scoping operations; auto-populated from the active task's project. */
  projectId?: string;
}

// Project tools (task creation/dispatch)
export type { AOFDispatchInput, AOFDispatchResult } from "./project-tools.js";
export { aofDispatch } from "./project-tools.js";

// Query tools (read-only)
export type { AOFStatusReportInput, AOFStatusReportResult } from "./query-tools.js";
export { aofStatusReport } from "./query-tools.js";

// Task tools (mutations)
export type {
  AOFTaskUpdateInput,
  AOFTaskUpdateResult,
  AOFTaskCompleteInput,
  AOFTaskCompleteResult,
  AOFTaskEditInput,
  AOFTaskEditResult,
  AOFTaskCancelInput,
  AOFTaskCancelResult,
  AOFTaskDepAddInput,
  AOFTaskDepAddResult,
  AOFTaskDepRemoveInput,
  AOFTaskDepRemoveResult,
  AOFTaskBlockInput,
  AOFTaskBlockResult,
  AOFTaskUnblockInput,
  AOFTaskUnblockResult,
} from "./task-tools.js";

export {
  aofTaskUpdate,
  aofTaskComplete,
  aofTaskEdit,
  aofTaskCancel,
  aofTaskDepAdd,
  aofTaskDepRemove,
  aofTaskBlock,
  aofTaskUnblock,
} from "./task-tools.js";
