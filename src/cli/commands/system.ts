/**
 * System commands — config, metrics, notifications, install, deps, channel, update.
 * 
 * This module re-exports command registration functions from specialized submodules.
 */

import type { Command } from "commander";
import {
  registerConfigCommands,
  registerMetricsCommands,
  registerNotificationsCommands,
} from "./config-commands.js";
import {
  registerInstallCommand,
  registerDepsCommands,
  registerChannelCommands,
  registerUpdateCommand,
} from "./system-commands.js";

/**
 * Register all system-related commands with the Commander program.
 */
export function registerSystemCommands(program: Command): void {
  // Configuration, metrics, notifications
  registerConfigCommands(program);
  registerMetricsCommands(program);
  registerNotificationsCommands(program);
  
  // Package management
  registerInstallCommand(program);
  registerDepsCommands(program);
  registerChannelCommands(program);
  registerUpdateCommand(program);
}
