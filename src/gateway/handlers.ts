import { collectMetrics } from "../metrics/collector.js";
import type { AOFMetrics } from "../metrics/exporter.js";
import type { ITaskStore } from "../store/interfaces.js";
import type { AOFService } from "../service/aof-service.js";

export interface GatewayRequest {
  method: string;
  path: string;
}

export interface GatewayResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export type GatewayHandler = (req: GatewayRequest) => Promise<GatewayResponse> | GatewayResponse;

export function createMetricsHandler(opts: {
  store: ITaskStore;
  metrics: AOFMetrics;
  service: AOFService;
}): GatewayHandler {
  return async () => {
    try {
      const state = await collectMetrics(opts.store);
      state.schedulerUp = opts.service.getStatus().running;
      opts.metrics.updateFromState(state);
      const body = await opts.metrics.getMetrics();
      return {
        status: 200,
        headers: { "Content-Type": opts.metrics.registry.contentType },
        body,
      };
    } catch (err) {
      return {
        status: 500,
        body: `Error: ${(err as Error).message}\n`,
      };
    }
  };
}

export function createStatusHandler(service: AOFService): GatewayHandler {
  return async () => {
    const body = JSON.stringify(service.getStatus());
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body,
    };
  };
}
