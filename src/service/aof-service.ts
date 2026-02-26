import { join } from "node:path";
import { FilesystemTaskStore } from "../store/task-store.js";
import type { ITaskStore } from "../store/interfaces.js";
import { EventLogger } from "../events/logger.js";
import { poll, type PollResult, type SchedulerConfig } from "../dispatch/scheduler.js";
import type { AOFMetrics } from "../metrics/exporter.js";
import type { NotificationService } from "../events/notifier.js";
import type { NotificationPolicyEngine } from "../events/notification-policy/index.js";
import { parseProtocolMessage, ProtocolRouter } from "../protocol/router.js";
import { discoverProjects, type ProjectRecord } from "../projects/index.js";
import { createMurmurHook } from "../dispatch/murmur-hooks.js";

export interface AOFServiceConfig {
  dataDir: string;
  dryRun?: boolean;
  pollIntervalMs?: number;
  defaultLeaseTtlMs?: number;
  /** Root directory for vault (Projects/, Resources/). If provided, enables multi-project mode. */
  vaultRoot?: string;
  /** Maximum concurrent in-progress tasks across all agents (default: 3). */
  maxConcurrentDispatches?: number;
  /**
   * When true, blocking a task cascades to its direct dependents in backlog/ready.
   * Default: false. See SchedulerConfig.cascadeBlocks.
   */
  cascadeBlocks?: boolean;
  /** Maximum time for a single poll cycle in ms (default: 30_000). */
  pollTimeoutMs?: number;
  /** Maximum time for a single task action in ms (default: 10_000). */
  taskActionTimeoutMs?: number;
}

export interface AOFServiceDependencies {
  store?: ITaskStore;
  logger?: EventLogger;
  metrics?: AOFMetrics;
  /** @deprecated Pass `engine` instead. Will be removed in a future release. */
  notifier?: NotificationService;
  /** Notification policy engine — wired to EventLogger.onEvent automatically. */
  engine?: NotificationPolicyEngine;
  poller?: typeof poll;
  executor?: import("../dispatch/executor.js").DispatchExecutor;
  protocolRouter?: ProtocolRouter;
}

export interface AOFServiceStatus {
  running: boolean;
  pollIntervalMs: number;
  lastPollAt?: string;
  lastPollDurationMs?: number;
  lastError?: string;
  lastPollResult?: PollResult;
}

export class AOFService {
  private readonly store: ITaskStore;
  private readonly logger: EventLogger;
  private readonly metrics?: AOFMetrics;
  private readonly notifier?: NotificationService;
  private readonly engine?: NotificationPolicyEngine;
  private readonly poller: typeof poll;
  private readonly schedulerConfig: SchedulerConfig;
  private readonly pollIntervalMs: number;
  private readonly protocolRouter: ProtocolRouter;
  private readonly vaultRoot?: string;
  private readonly pollTimeoutMs: number;

  // Multi-project support
  private projectStores: Map<string, ITaskStore> = new Map();
  private projects: ProjectRecord[] = [];

  private running = false;
  private pollTimer?: NodeJS.Timeout;
  private pollQueue: Promise<void> = Promise.resolve();
  private lastPollAt?: string;
  private lastPollDurationMs?: number;
  private lastError?: string;
  private lastPollResult?: PollResult;

  constructor(deps: AOFServiceDependencies, config: AOFServiceConfig) {
    this.vaultRoot = config.vaultRoot;
    
    // Wire engine to EventLogger so ALL logged events route through it automatically
    this.engine = deps.engine;
    this.logger = deps.logger ?? new EventLogger(join(config.dataDir, "events"), {
      onEvent: deps.engine ? (e) => deps.engine!.handleEvent(e) : undefined,
    });

    const storeWithHooks = deps.store ?? new FilesystemTaskStore(config.dataDir, {
      hooks: this.createStoreHooks(config.dataDir),
    });

    this.store = storeWithHooks;
    this.metrics = deps.metrics;
    this.notifier = deps.notifier;
    this.poller = deps.poller ?? poll;
    this.pollIntervalMs = config.pollIntervalMs ?? 30_000;
    this.pollTimeoutMs = config.pollTimeoutMs ?? 30_000;

    // Build project store resolver for protocol router
    const projectStoreResolver = this.vaultRoot
      ? (projectId: string) => this.projectStores.get(projectId)
      : undefined;
    
    this.protocolRouter = deps.protocolRouter ?? new ProtocolRouter({
      store: storeWithHooks,
      logger: this.logger,
      notifier: this.notifier,
      projectStoreResolver,
      cascadeBlocks: config.cascadeBlocks,
    });
    
    this.schedulerConfig = {
      dataDir: config.dataDir,
      dryRun: config.dryRun ?? false,
      defaultLeaseTtlMs: config.defaultLeaseTtlMs ?? 600_000,
      executor: deps.executor,
      maxConcurrentDispatches: config.maxConcurrentDispatches,
      cascadeBlocks: config.cascadeBlocks,
      pollTimeoutMs: config.pollTimeoutMs,
      taskActionTimeoutMs: config.taskActionTimeoutMs,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    
    // Initialize projects if multi-project mode
    if (this.vaultRoot) {
      await this.initializeProjects();
    } else {
      await this.store.init();
    }
    
    this.running = true;

    // Log startup — engine picks it up via EventLogger.onEvent callback
    await this.logger.logSystem("system.startup");

    await this.triggerPoll("startup");

    this.pollTimer = setInterval(() => {
      void this.triggerPoll("interval");
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async handleSessionEnd(_event?: unknown): Promise<void> {
    if ("handleSessionEnd" in this.protocolRouter) {
      const handler = (this.protocolRouter as ProtocolRouter).handleSessionEnd?.bind(this.protocolRouter);
      if (handler) {
        await handler();
      }
    }

    await this.triggerPoll("session_end");
  }

  async handleAgentEnd(_event?: unknown): Promise<void> {
    await this.triggerPoll("agent_end");
  }

  async handleMessageReceived(event?: unknown): Promise<void> {
    const envelope = parseProtocolMessage(event, this.logger);
    if (envelope) {
      await this.protocolRouter.route(envelope);
    }

    await this.triggerPoll("message_received");
  }

  getStatus(): AOFServiceStatus {
    return {
      running: this.running,
      pollIntervalMs: this.pollIntervalMs,
      lastPollAt: this.lastPollAt,
      lastPollDurationMs: this.lastPollDurationMs,
      lastError: this.lastError,
      lastPollResult: this.lastPollResult,
    };
  }

  private async triggerPoll(_reason: string): Promise<void> {
    if (!this.running) return;
    this.pollQueue = this.pollQueue.then(() => this.runPoll());
    return this.pollQueue;
  }

  private async initializeProjects(): Promise<void> {
    if (!this.vaultRoot) return;

    this.projects = await discoverProjects(this.vaultRoot);
    
    // Create TaskStore for each valid project (skip those with errors)
    for (const project of this.projects) {
      if (project.error) {
        console.warn(`[AOF] Skipping project ${project.id}: ${project.error}`);
        continue;
      }

      const store = new FilesystemTaskStore(project.path, {
        projectId: project.id,
        hooks: this.createStoreHooks(project.path),
        logger: this.logger,
      });
      
      await store.init();
      this.projectStores.set(project.id, store);
    }

    console.info(`[AOF] Initialized ${this.projectStores.size} project stores`);
  }

  private async runPoll(): Promise<void> {
    const start = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.pollTimeoutMs);

    try {
      const pollPromise = this.vaultRoot && this.projectStores.size > 0
        ? this.pollAllProjects()
        : this.poller(this.store, this.logger, this.schedulerConfig);

      const result = await Promise.race([
        pollPromise,
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new Error(`Poll timeout after ${this.pollTimeoutMs}ms`));
          });
        }),
      ]);

      this.lastPollResult = result;
      this.lastPollAt = new Date().toISOString();
      this.lastError = undefined;
      if (this.metrics) {
        const durationSeconds = (performance.now() - start) / 1000;
        this.metrics.observePollDuration(durationSeconds);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("Poll timeout")) {
        console.warn(`[AOF] Poll timed out after ${this.pollTimeoutMs}ms — skipping to next cycle`);
        try {
          await this.logger.log("poll.timeout", "scheduler", {
            payload: { timeoutMs: this.pollTimeoutMs, durationMs: Math.round(performance.now() - start) },
          });
        } catch {
          // Logging errors should not break the poll cycle
        }
      }
      this.lastError = message;
      if (this.metrics) this.metrics.recordPollFailure();
    } finally {
      clearTimeout(timeoutId);
      this.lastPollDurationMs = Math.round(performance.now() - start);
    }
  }

  private async pollAllProjects(): Promise<PollResult> {
    const results: PollResult[] = [];
    const aggregateStart = performance.now();
    
    // Poll each project store
    for (const [projectId, store] of this.projectStores) {
      try {
        const result = await this.poller(store, this.logger, this.schedulerConfig);
        results.push(result);
      } catch (err) {
        console.error(`[AOF] Failed to poll project ${projectId}: ${(err as Error).message}`);
      }
    }
    
    // Aggregate results
    const aggregated: PollResult = {
      scannedAt: new Date().toISOString(),
      durationMs: performance.now() - aggregateStart,
      dryRun: this.schedulerConfig.dryRun,
      actions: results.flatMap(r => r.actions),
      stats: {
        total: 0,
        backlog: 0,
        ready: 0,
        inProgress: 0,
        blocked: 0,
        review: 0,
        done: 0,
      },
    };
    
    // Sum stats across all projects
    for (const result of results) {
      aggregated.stats.total += result.stats.total;
      aggregated.stats.backlog += result.stats.backlog;
      aggregated.stats.ready += result.stats.ready;
      aggregated.stats.inProgress += result.stats.inProgress;
      aggregated.stats.blocked += result.stats.blocked;
      aggregated.stats.review += result.stats.review;
      aggregated.stats.done += result.stats.done;
    }
    
    return aggregated;
  }

  private createStoreHooks(
    projectRoot?: string
  ): import("../store/task-store.js").TaskStoreHooks {
    // Create murmur hook for orchestration review tracking
    const murmurHook = projectRoot ? createMurmurHook(projectRoot) : undefined;

    return {
      afterTransition: async (task, previousStatus) => {
        // Murmur state tracking (completions, failures, review end)
        if (murmurHook) {
          await murmurHook(task, previousStatus);
        }

        // Route task.transitioned event through the engine via EventLogger.
        // Engine deduplication suppresses duplicate sends for router-driven
        // transitions that also call logTransition() explicitly.
        await this.logger.logTransition(
          task.frontmatter.id,
          previousStatus,
          task.frontmatter.status,
          task.frontmatter.lease?.agent ?? "system",
        );
      },
    };
  }
}
