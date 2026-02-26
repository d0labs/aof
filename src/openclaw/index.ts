/**
 * OpenClaw integration exports.
 */

export { registerAofPlugin, type AOFPluginOptions } from "./adapter.js";
export { OpenClawAdapter, OpenClawExecutor } from "./executor.js";
export { MatrixNotifier, MockMatrixMessageTool, type MatrixMessageTool } from "./matrix-notifier.js";
export type {
  OpenClawServiceDefinition,
  OpenClawToolDefinition,
  OpenClawToolOpts,
  OpenClawHttpRouteDefinition,
  OpenClawApi,
} from "./types.js";
