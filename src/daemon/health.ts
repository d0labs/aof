import type { ITaskStore } from "../store/interfaces.js";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  lastPollAt: number;
  lastEventAt: number;
  taskCounts: {
    open: number;
    ready: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
}

export interface DaemonState {
  lastPollAt: number;
  lastEventAt: number;
  uptime: number;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export async function getHealthStatus(
  state: DaemonState,
  store: ITaskStore,
): Promise<HealthStatus> {
  const now = Date.now();

  // Check if scheduler is stale
  const isStale = now - state.lastPollAt > STALE_THRESHOLD_MS;

  // Try to get task counts (basic health check)
  let taskCounts;
  let storeHealthy = true;
  try {
    const counts = await store.countByStatus();
    taskCounts = {
      open: counts.backlog ?? 0,
      ready: counts.ready ?? 0,
      inProgress: counts["in-progress"] ?? 0,
      blocked: counts.blocked ?? 0,
      done: counts.done ?? 0,
    };
  } catch (err) {
    storeHealthy = false;
    taskCounts = {
      open: 0,
      ready: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
    };
  }

  const status = isStale || !storeHealthy ? "unhealthy" : "healthy";

  return {
    status,
    uptime: state.uptime,
    lastPollAt: state.lastPollAt,
    lastEventAt: state.lastEventAt,
    taskCounts,
  };
}
