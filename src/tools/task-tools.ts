/**
 * AOF task tools — task manipulation operations (update, complete, cancel, deps, block).
 * 
 * This module re-exports from specialized submodules to maintain backward compatibility.
 */

// Re-export CRUD operations
export {
  aofTaskUpdate,
  aofTaskEdit,
  aofTaskCancel,
  type AOFTaskUpdateInput,
  type AOFTaskUpdateResult,
  type AOFTaskEditInput,
  type AOFTaskEditResult,
  type AOFTaskCancelInput,
  type AOFTaskCancelResult,
} from "./task-crud-tools.js";

// Re-export workflow operations
export {
  aofTaskComplete,
  aofTaskDepAdd,
  aofTaskDepRemove,
  aofTaskBlock,
  aofTaskUnblock,
  type AOFTaskCompleteInput,
  type AOFTaskCompleteResult,
  type AOFTaskDepAddInput,
  type AOFTaskDepAddResult,
  type AOFTaskDepRemoveInput,
  type AOFTaskDepRemoveResult,
  type AOFTaskBlockInput,
  type AOFTaskBlockResult,
  type AOFTaskUnblockInput,
  type AOFTaskUnblockResult,
} from "./task-workflow-tools.js";
