import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ITaskStore } from "../store/interfaces.js";
import { getHealthStatus, type DaemonState } from "./health.js";

export type DaemonStateProvider = () => DaemonState;

/**
 * Create and start an HTTP server with health endpoint.
 */
export function createHealthServer(
  getState: DaemonStateProvider,
  store: ITaskStore,
  port = 3000,
  bind = "127.0.0.1",
): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Only handle GET /health
    if (req.method === "GET" && req.url === "/health") {
      try {
        const state = getState();
        const health = await getHealthStatus(state, store);
        const httpStatus = health.status === "healthy" ? 200 : 503;
        
        res.writeHead(httpStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
      } catch (err) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "unhealthy",
          error: (err as Error).message,
        }));
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });

  server.listen(port, bind);
  return server;
}
