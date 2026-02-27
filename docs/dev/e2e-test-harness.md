# AOF E2E Test Harness — Design Document

**Status:** APPROVED FOR IMPLEMENTATION  
**Owner:** swe-architect  
**Implementation Lead:** swe-qa  
**Priority:** CRITICAL  
**Created:** 2026-02-07

---

## Addendum (2026-02-08): Containerized OpenClaw Test Environment (Required)

Before **any** production deployment, QA must validate AOF in a **containerized OpenClaw gateway**. A Docker Compose setup now lives at:

```
~/Projects/AOF/tests/integration/openclaw/
```

This environment mounts the built AOF plugin artifacts, loads OpenClaw with the real plugin API, and is the required QA gate prior to gateway restarts or production deployment.

### Test Hierarchy (Unit → Integration → E2E)

**Unit tests** (`src/**/__tests__/*.test.ts`):
- Use mocks for external dependencies
- Fast, deterministic, no external services required
- Run via `npm test`

**Integration tests** (`tests/integration/*.test.ts`):
- Run against **real containerized OpenClaw**
- Validate plugin loads, tools register, API signatures match
- Run via `npm run test:integration:plugin`
- **Required for deployment artifacts** (per `docs/DEFINITION-OF-DONE.md`)

**E2E tests** (`tests/e2e/suites/*.test.ts`):
- Full workflow tests (dispatch → spawn → complete)
- Use real TaskStore, EventLogger, scheduler
- Run via `npm run test:e2e`
- May use containerized OpenClaw or local gateway

**Critical distinction:** Integration tests validate the **plugin API contract** against the real OpenClaw. E2E tests validate **AOF business logic** end-to-end. Both are required.

---

## 1. Executive Summary

AOF currently has 279 passing unit/integration tests, all with mocked OpenClaw dependencies. **Zero end-to-end tests exist against a real OpenClaw instance.** This design specifies a production-ready E2E test harness where:

1. **AOF plugin runs inside a real OpenClaw gateway** (not mocked)
2. **Test agents** can execute real tool calls and state transitions
3. **All core workflows** are verified (dispatch, spawn, completion, recovery, views, metrics)
4. **Tests are deterministic, fast, and CI-compatible**
5. **The harness itself is tested** (TDD principle applies to test infrastructure)

---

## 2. Architecture Decision: Profile-Based Primary + Docker Optional

### 2.1 Recommended Approach: Profile-Based

**Rationale:**
- ✅ **No Docker dependency** — avoids Colima QEMU panics in containerized environments
- ✅ **Fast startup** — OpenClaw gateway starts in <2s
- ✅ **Easy debugging** — logs, state, and artifacts are directly accessible
- ✅ **CI-compatible** — runs in GitHub Actions without Docker setup
- ✅ **Matches production use** — tests how users will actually deploy AOF

**Implementation:**
```bash
openclaw --profile aof-e2e-test gateway run \
  --port 19003 \
  --token test-token-12345 \
  --bind loopback
```

This creates an isolated OpenClaw instance:
- **State dir:** `~/.openclaw-aof-e2e-test/`
- **Config:** `~/.openclaw-aof-e2e-test/openclaw.json`
- **Sessions:** `~/.openclaw-aof-e2e-test/sessions/`
- **No interference** with main OpenClaw instance

### 2.2 Docker Option (Now Required)

**When to use:**
- QA validation prior to any production deployment (mandatory)
- Running E2E tests in isolated CI environments (GitLab, Jenkins)
- Testing AOF across multiple OpenClaw versions simultaneously
- Full hermetic test environments

**Status:** Required as of 2026-02-08 (see Addendum). The Docker Compose harness is located at `tests/integration/openclaw/`.

---

## 3. E2E Test Infrastructure Design

### 3.1 Test Environment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  E2E Test Harness (vitest process)                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Test Orchestrator                                        │  │
│  │  - Setup/teardown lifecycle                               │  │
│  │  - Gateway process management                             │  │
│  │  - Test data seeding                                      │  │
│  │  - Assertions & verification                              │  │
│  └───────────────────────────────────────────────────────────┘  │
│         │                                                         │
│         │ (HTTP, WebSocket)                                      │
│         ▼                                                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  OpenClaw Gateway (subprocess)                            │  │
│  │  - Profile: aof-e2e-test                                  │  │
│  │  - Port: 19003                                            │  │
│  │  - Model: mock-test-provider                              │  │
│  │  - Agents: test-agent-1, test-agent-2, test-agent-3      │  │
│  └───────────────────────────────────────────────────────────┘  │
│         │                                                         │
│         │ (Plugin API)                                           │
│         ▼                                                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  AOF Plugin (loaded via adapter.ts)                       │  │
│  │  - TaskStore                                              │  │
│  │  - AOFService (scheduler)                                 │  │
│  │  - Tools (aof_task_update, aof_task_complete)            │  │
│  │  - Gateway endpoints (/metrics, /aof/status)             │  │
│  └───────────────────────────────────────────────────────────┘  │
│         │                                                         │
│         │ (Filesystem)                                           │
│         ▼                                                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  AOF Test Data Directory                                  │  │
│  │  ~/.openclaw-aof-e2e-test/aof-test-data/                 │  │
│  │  ├── tasks/                                               │  │
│  │  │   ├── inbox/                                           │  │
│  │  │   ├── ready/                                           │  │
│  │  │   ├── active/                                          │  │
│  │  │   ├── review/                                          │  │
│  │  │   └── done/                                            │  │
│  │  ├── org/                                                 │  │
│  │  │   └── org-chart.yaml                                   │  │
│  │  ├── events/                                              │  │
│  │  └── views/                                               │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 OpenClaw Test Configuration

**Test Profile Configuration** (`~/.openclaw-aof-e2e-test/openclaw.json`):

```json
{
  "version": "2026.2.6",
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": 19003,
    "auth": "token"
  },
  "models": {
    "providers": {
      "mock-test": {
        "type": "mock",
        "responses": {
          "default": "Task acknowledged. Proceeding with execution.",
          "tool_calls": true
        }
      }
    }
  },
  "agents": {
    "test-agent-1": {
      "model": "mock-test/default",
      "tools": ["aof_task_update", "aof_status_report", "aof_task_complete"],
      "workspace": "~/.openclaw-aof-e2e-test/workspace-agent-1"
    },
    "test-agent-2": {
      "model": "mock-test/default",
      "tools": ["aof_task_update", "aof_status_report", "aof_task_complete"],
      "workspace": "~/.openclaw-aof-e2e-test/workspace-agent-2"
    },
    "test-agent-3": {
      "model": "mock-test/default",
      "tools": ["aof_task_update", "aof_status_report", "aof_task_complete"],
      "workspace": "~/.openclaw-aof-e2e-test/workspace-agent-3"
    }
  },
  "plugins": [
    {
      "name": "aof",
      "path": "/path/to/aof/dist/index.js",
      "options": {
        "dataDir": "~/.openclaw-aof-e2e-test/aof-test-data",
        "dryRun": false,
        "pollIntervalMs": 1000,
        "defaultLeaseTtlMs": 30000
      }
    }
  ]
}
```

**Key Configuration Decisions:**
- **Mock model provider:** Fast, no API costs, deterministic responses
- **3 test agents:** Sufficient to test concurrent dispatch and lease management
- **Short poll interval (1s):** Fast test execution (production uses 5-10s)
- **Short lease TTL (30s):** Quick timeout testing
- **dryRun: false:** Tests run real spawns (not simulation mode)

### 3.3 Mock Model Provider

**Option 1: Built-in OpenClaw Mock Provider** (if available in 2026.2.6)
```json
{
  "type": "mock",
  "responses": {
    "default": "Acknowledged.",
    "tool_calls": true
  }
}
```

**Option 2: Custom Test Model Provider** (if OpenClaw doesn't have built-in mock)

Create `tests/e2e/mock-model-provider.ts`:
```typescript
export class MockModelProvider {
  async generate(prompt: string, options: any): Promise<string> {
    // Parse tool calls from prompt
    if (prompt.includes('aof_task_complete')) {
      return JSON.stringify({
        tool_calls: [{
          name: 'aof_task_complete',
          arguments: { taskId: 'extracted-from-prompt' }
        }]
      });
    }
    return 'Task acknowledged. Proceeding.';
  }
}
```

**Decision:** Try Option 1 first. If OpenClaw 2026.2.6 lacks mock provider, implement Option 2.

### 3.4 Test Data Management

**Test Data Fixtures:**
```
tests/e2e/fixtures/
├── org-chart-test.yaml          # Minimal org chart (3 agents)
├── tasks/
│   ├── task-001-simple.md       # Simple task for basic flow
│   ├── task-002-multi-step.md   # Multi-step task for completion flow
│   ├── task-003-concurrent.md   # For concurrent dispatch testing
│   └── task-004-timeout.md      # For timeout/recovery testing
└── expected-outputs/
    ├── metrics-baseline.txt     # Expected Prometheus metrics format
    └── status-baseline.json     # Expected /aof/status response
```

**Seeding Strategy:**
```typescript
// tests/e2e/utils/test-data.ts
export async function seedTestData(dataDir: string) {
  await fs.mkdir(`${dataDir}/tasks/inbox`, { recursive: true });
  await fs.copyFile(
    'tests/e2e/fixtures/tasks/task-001-simple.md',
    `${dataDir}/tasks/inbox/task-001-simple.md`
  );
  await fs.copyFile(
    'tests/e2e/fixtures/org-chart-test.yaml',
    `${dataDir}/org/org-chart.yaml`
  );
}

export async function cleanupTestData(dataDir: string) {
  await fs.rm(dataDir, { recursive: true, force: true });
}
```

**Cleanup Strategy:**
- **Before each test suite:** Wipe `~/.openclaw-aof-e2e-test/`
- **After each test:** Reset AOF state (move tasks back to inbox)
- **After test failure:** Preserve logs/state in `tests/e2e/failures/<timestamp>/`

---

## 4. E2E Test Scenarios (Detailed)

### 4.1 Tier 1: Core Functionality (Blocking)

#### Test 1.1: Plugin Registration
```typescript
describe('E2E: Plugin Registration', () => {
  it('should load AOF plugin and register all components', async () => {
    const gateway = await startTestGateway();
    
    // Verify service registration
    const services = await gateway.listServices();
    expect(services).toContain('aof-scheduler');
    
    // Verify tool registration
    const tools = await gateway.listTools();
    expect(tools).toContain('aof_task_update');
    expect(tools).toContain('aof_status_report');
    expect(tools).toContain('aof_task_complete');
    
    // Verify CLI registration
    const clis = await gateway.listClis();
    expect(clis).toContain('aof lint');
    expect(clis).toContain('aof board');
    expect(clis).toContain('aof drift');
    
    // Verify gateway endpoints
    const response = await fetch('http://localhost:19003/metrics');
    expect(response.status).toBe(200);
    
    const statusResponse = await fetch('http://localhost:19003/aof/status');
    expect(statusResponse.status).toBe(200);
    
    await gateway.stop();
  });
});
```

#### Test 1.2: Tool Execution
```typescript
describe('E2E: Tool Execution', () => {
  it('should execute aof_task_update successfully', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    const result = await gateway.callTool('aof_task_update', {
      taskId: 'task-001-simple',
      status: 'active',
      updates: { progress: 'Started work' }
    });
    
    expect(result.ok).toBe(true);
    
    // Verify filesystem state
    const taskPath = `${testDataDir}/tasks/active/task-001-simple.md`;
    const taskExists = await fs.access(taskPath).then(() => true).catch(() => false);
    expect(taskExists).toBe(true);
    
    await gateway.stop();
  });
  
  it('should execute aof_task_complete successfully', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    // Move task to active first
    await gateway.callTool('aof_task_update', {
      taskId: 'task-001-simple',
      status: 'active'
    });
    
    const result = await gateway.callTool('aof_task_complete', {
      taskId: 'task-001-simple',
      outcome: 'Task completed successfully'
    });
    
    expect(result.ok).toBe(true);
    
    // Verify task moved to done/
    const donePath = `${testDataDir}/tasks/done/task-001-simple.md`;
    const doneExists = await fs.access(donePath).then(() => true).catch(() => false);
    expect(doneExists).toBe(true);
    
    await gateway.stop();
  });
});
```

#### Test 1.3: Dispatch → Spawn → Complete (Full Flow)
```typescript
describe('E2E: Dispatch to Completion Flow', () => {
  it('should dispatch task, spawn agent, and complete successfully', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    // Seed a ready task
    await fs.writeFile(
      `${testDataDir}/tasks/ready/task-001-simple.md`,
      createTaskMarkdown({
        id: 'task-001-simple',
        title: 'Test Task',
        status: 'ready',
        assignedTo: 'test-agent-1'
      })
    );
    
    // Start AOF scheduler
    await gateway.startService('aof-scheduler');
    
    // Wait for scheduler to dispatch (poll interval is 1s)
    await sleep(2000);
    
    // Verify task moved to active/
    const activePath = `${testDataDir}/tasks/active/task-001-simple.md`;
    const activeExists = await fs.access(activePath).then(() => true).catch(() => false);
    expect(activeExists).toBe(true);
    
    // Verify agent spawned
    const sessions = await gateway.listSessions();
    const agentSession = sessions.find(s => s.agent === 'test-agent-1');
    expect(agentSession).toBeDefined();
    
    // Simulate agent completing task
    await gateway.callTool('aof_task_complete', {
      taskId: 'task-001-simple',
      outcome: 'Completed'
    });
    
    // Wait for state transition
    await sleep(1000);
    
    // Verify task moved to done/
    const donePath = `${testDataDir}/tasks/done/task-001-simple.md`;
    const doneExists = await fs.access(donePath).then(() => true).catch(() => false);
    expect(doneExists).toBe(true);
    
    await gateway.stop();
  });
});
```

#### Test 1.4: View Updates
```typescript
describe('E2E: View Updates', () => {
  it('should reflect state changes in mailbox view', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    // Get initial mailbox state
    const mailboxBefore = await gateway.callCli('aof', ['mailbox', 'test-agent-1']);
    expect(mailboxBefore.inbox).toHaveLength(0);
    
    // Assign task to agent
    await fs.writeFile(
      `${testDataDir}/tasks/ready/task-001.md`,
      createTaskMarkdown({
        id: 'task-001',
        status: 'ready',
        assignedTo: 'test-agent-1'
      })
    );
    
    // Refresh mailbox view
    const mailboxAfter = await gateway.callCli('aof', ['mailbox', 'test-agent-1']);
    expect(mailboxAfter.inbox).toHaveLength(1);
    expect(mailboxAfter.inbox[0].id).toBe('task-001');
    
    await gateway.stop();
  });
  
  it('should reflect state changes in kanban board', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    // Get initial board
    const boardBefore = await gateway.callCli('aof', ['board']);
    expect(boardBefore.ready || []).toHaveLength(0);
    
    // Add tasks to various statuses
    await seedMultipleStatuses(testDataDir, [
      { status: 'ready', count: 2 },
      { status: 'active', count: 1 },
      { status: 'done', count: 3 }
    ]);
    
    // Refresh board
    const boardAfter = await gateway.callCli('aof', ['board']);
    expect(boardAfter.ready).toHaveLength(2);
    expect(boardAfter.active).toHaveLength(1);
    expect(boardAfter.done).toHaveLength(3);
    
    await gateway.stop();
  });
});
```

#### Test 1.5: Resume Protocol (Stale Heartbeat)
```typescript
describe('E2E: Resume Protocol', () => {
  it('should move task to review/ when agent session ends unexpectedly', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    // Seed active task with lease
    await fs.writeFile(
      `${testDataDir}/tasks/active/task-001.md`,
      createTaskMarkdown({
        id: 'task-001',
        status: 'active',
        assignedTo: 'test-agent-1',
        lease: {
          sessionId: 'test-session-123',
          expiresAt: new Date(Date.now() + 30000).toISOString()
        }
      })
    );
    
    // Start scheduler
    await gateway.startService('aof-scheduler');
    
    // Kill the agent session
    await gateway.killSession('test-session-123');
    
    // Wait for scheduler to detect stale lease (poll + TTL check)
    await sleep(35000); // Lease TTL is 30s + 1s poll
    
    // Verify task moved to review/
    const reviewPath = `${testDataDir}/tasks/review/task-001.md`;
    const reviewExists = await fs.access(reviewPath).then(() => true).catch(() => false);
    expect(reviewExists).toBe(true);
    
    // Verify lease cleared
    const task = await readTask(reviewPath);
    expect(task.frontmatter.lease).toBeUndefined();
    
    await gateway.stop();
  });
});
```

#### Test 1.6: Metrics Endpoint
```typescript
describe('E2E: Metrics Endpoint', () => {
  it('should return Prometheus-formatted metrics', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    // Seed tasks in various statuses
    await seedMultipleStatuses(testDataDir, [
      { status: 'inbox', count: 2 },
      { status: 'ready', count: 3 },
      { status: 'active', count: 1 },
      { status: 'review', count: 1 },
      { status: 'done', count: 10 }
    ]);
    
    const response = await fetch('http://localhost:19003/metrics');
    expect(response.status).toBe(200);
    
    const text = await response.text();
    
    // Verify Prometheus format
    expect(text).toContain('# HELP aof_tasks_total Total number of tasks');
    expect(text).toContain('# TYPE aof_tasks_total gauge');
    expect(text).toContain('aof_tasks_total{status="inbox"} 2');
    expect(text).toContain('aof_tasks_total{status="ready"} 3');
    expect(text).toContain('aof_tasks_total{status="active"} 1');
    expect(text).toContain('aof_tasks_total{status="review"} 1');
    expect(text).toContain('aof_tasks_total{status="done"} 10');
    
    await gateway.stop();
  });
});
```

#### Test 1.7: Gateway Status Endpoint
```typescript
describe('E2E: Gateway Status Endpoint', () => {
  it('should return scheduler health status', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    await gateway.startService('aof-scheduler');
    
    const response = await fetch('http://localhost:19003/aof/status');
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data).toMatchObject({
      scheduler: {
        running: true,
        pollIntervalMs: 1000,
        lastPollAt: expect.any(String)
      },
      tasks: {
        inbox: expect.any(Number),
        ready: expect.any(Number),
        active: expect.any(Number),
        review: expect.any(Number),
        done: expect.any(Number)
      }
    });
    
    await gateway.stop();
  });
});
```

#### Test 1.8: Concurrent Dispatch (Lease Manager)
```typescript
describe('E2E: Concurrent Dispatch', () => {
  it('should prevent double-spawn via lease manager', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    // Seed 5 ready tasks
    for (let i = 1; i <= 5; i++) {
      await fs.writeFile(
        `${testDataDir}/tasks/ready/task-00${i}.md`,
        createTaskMarkdown({
          id: `task-00${i}`,
          status: 'ready',
          assignedTo: 'test-agent-1'
        })
      );
    }
    
    // Start scheduler with 3 agents
    await gateway.startService('aof-scheduler');
    
    // Wait for dispatches (5 tasks / 3 agents = 2 rounds)
    await sleep(5000);
    
    // Verify no task was dispatched twice
    const sessions = await gateway.listSessions();
    const taskIds = sessions.map(s => s.context?.taskId).filter(Boolean);
    const uniqueTaskIds = new Set(taskIds);
    expect(taskIds.length).toBe(uniqueTaskIds.size);
    
    // Verify at most 3 active tasks (agent limit)
    const activeTasks = await fs.readdir(`${testDataDir}/tasks/active`);
    expect(activeTasks.length).toBeLessThanOrEqual(3);
    
    await gateway.stop();
  });
});
```

#### Test 1.9: Drift Detection
```typescript
describe('E2E: Drift Detection', () => {
  it('should detect drift between org chart and live agents', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    // Org chart lists: test-agent-1, test-agent-2, test-agent-3
    // But only test-agent-1 and test-agent-2 are configured in OpenClaw
    
    const result = await gateway.callCli('aof', ['drift', 'live']);
    
    expect(result.ok).toBe(true);
    expect(result.drift).toBeDefined();
    expect(result.drift.missingInOpenClaw).toContain('test-agent-3');
    
    await gateway.stop();
  });
});
```

### 4.2 Tier 2: Robustness (Important)

#### Test 2.1: Gateway Restart Resilience
```typescript
describe('E2E: Gateway Restart', () => {
  it('should resume scheduler state after gateway restart', async () => {
    let gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    // Seed active task
    await fs.writeFile(
      `${testDataDir}/tasks/active/task-001.md`,
      createTaskMarkdown({
        id: 'task-001',
        status: 'active',
        assignedTo: 'test-agent-1'
      })
    );
    
    await gateway.startService('aof-scheduler');
    await sleep(2000);
    
    // Stop gateway
    await gateway.stop();
    
    // Restart gateway
    gateway = await startTestGateway();
    await gateway.startService('aof-scheduler');
    
    // Verify scheduler picked up existing active task
    const statusResponse = await fetch('http://localhost:19003/aof/status');
    const data = await statusResponse.json();
    expect(data.tasks.active).toBe(1);
    
    await gateway.stop();
  });
});
```

#### Test 2.2: Invalid Task Handling
```typescript
describe('E2E: Error Handling', () => {
  it('should handle malformed task files gracefully', async () => {
    const gateway = await startTestGateway();
    await seedTestData(testDataDir);
    
    // Write invalid task (missing required frontmatter)
    await fs.writeFile(
      `${testDataDir}/tasks/inbox/invalid-task.md`,
      '# This is not a valid task\n\nNo frontmatter!'
    );
    
    // Run linter
    const result = await gateway.callCli('aof', ['lint']);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].file).toContain('invalid-task.md');
    
    await gateway.stop();
  });
});
```

---

## 5. Test Harness Implementation

### 5.1 Code Structure

```
tests/
├── e2e/
│   ├── setup/
│   │   ├── gateway-manager.ts      # Start/stop OpenClaw gateway
│   │   ├── test-config.ts          # Generate test OpenClaw config
│   │   └── cleanup.ts              # Pre/post test cleanup
│   ├── utils/
│   │   ├── test-data.ts            # Seed/cleanup test data
│   │   ├── task-factory.ts         # Generate test tasks
│   │   ├── assertions.ts           # Custom matchers
│   │   └── wait.ts                 # Async wait helpers
│   ├── fixtures/
│   │   ├── org-chart-test.yaml
│   │   └── tasks/
│   │       ├── task-001-simple.md
│   │       └── ...
│   ├── suites/
│   │   ├── 01-plugin-registration.test.ts
│   │   ├── 02-tool-execution.test.ts
│   │   ├── 03-dispatch-flow.test.ts
│   │   ├── 04-view-updates.test.ts
│   │   ├── 05-resume-protocol.test.ts
│   │   ├── 06-metrics-endpoint.test.ts
│   │   ├── 07-status-endpoint.test.ts
│   │   ├── 08-concurrent-dispatch.test.ts
│   │   └── 09-drift-detection.test.ts
│   └── README.md                   # E2E test documentation
└── vitest.e2e.config.ts             # Separate vitest config for E2E
```

### 5.2 Gateway Manager (Core Infrastructure)

```typescript
// tests/e2e/setup/gateway-manager.ts
import { spawn, ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface GatewayManagerOptions {
  profile: string;
  port: number;
  token: string;
  aofDataDir: string;
  aofPluginPath: string;
  verbose?: boolean;
}

export class GatewayManager {
  private process?: ChildProcess;
  private options: GatewayManagerOptions;
  private stateDir: string;

  constructor(options: GatewayManagerOptions) {
    this.options = options;
    this.stateDir = join(
      process.env.HOME!,
      `.openclaw-${options.profile}`
    );
  }

  async start(): Promise<void> {
    // Ensure clean state
    await this.cleanup();
    await mkdir(this.stateDir, { recursive: true });

    // Generate OpenClaw config
    await this.generateConfig();

    // Start gateway process
    this.process = spawn('openclaw', [
      '--profile', this.options.profile,
      'gateway', 'run',
      '--port', String(this.options.port),
      '--token', this.options.token,
      '--bind', 'loopback'
    ], {
      stdio: this.options.verbose ? 'inherit' : 'pipe',
      env: { ...process.env }
    });

    // Wait for gateway to be ready
    await this.waitForHealth();
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      await setTimeout(1000);
      if (!this.process.killed) {
        this.process.kill('SIGKILL');
      }
      this.process = undefined;
    }
  }

  async cleanup(): Promise<void> {
    await rm(this.stateDir, { recursive: true, force: true });
    await rm(this.options.aofDataDir, { recursive: true, force: true });
  }

  private async generateConfig(): Promise<void> {
    const config = {
      version: '2026.2.6',
      gateway: {
        mode: 'local',
        bind: 'loopback',
        port: this.options.port,
        auth: 'token'
      },
      models: {
        providers: {
          'mock-test': {
            type: 'mock',
            responses: {
              default: 'Task acknowledged.',
              tool_calls: true
            }
          }
        }
      },
      agents: {
        'test-agent-1': {
          model: 'mock-test/default',
          tools: ['aof_task_update', 'aof_status_report', 'aof_task_complete'],
          workspace: join(this.stateDir, 'workspace-agent-1')
        },
        'test-agent-2': {
          model: 'mock-test/default',
          tools: ['aof_task_update', 'aof_status_report', 'aof_task_complete'],
          workspace: join(this.stateDir, 'workspace-agent-2')
        },
        'test-agent-3': {
          model: 'mock-test/default',
          tools: ['aof_task_update', 'aof_status_report', 'aof_task_complete'],
          workspace: join(this.stateDir, 'workspace-agent-3')
        }
      },
      plugins: [
        {
          name: 'aof',
          path: this.options.aofPluginPath,
          options: {
            dataDir: this.options.aofDataDir,
            dryRun: false,
            pollIntervalMs: 1000,
            defaultLeaseTtlMs: 30000
          }
        }
      ]
    };

    const configPath = join(this.stateDir, 'openclaw.json');
    await writeFile(configPath, JSON.stringify(config, null, 2));
  }

  private async waitForHealth(): Promise<void> {
    const maxAttempts = 30;
    const delayMs = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`http://localhost:${this.options.port}/health`);
        if (response.ok) {
          return;
        }
      } catch {
        // Gateway not ready yet
      }
      await setTimeout(delayMs);
    }

    throw new Error(`Gateway failed to start after ${maxAttempts * delayMs}ms`);
  }

  async callTool(name: string, input: unknown): Promise<any> {
    const response = await fetch(`http://localhost:${this.options.port}/api/tools/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.options.token}`
      },
      body: JSON.stringify({ input })
    });

    if (!response.ok) {
      throw new Error(`Tool call failed: ${response.statusText}`);
    }

    return response.json();
  }

  async callCli(command: string, args: string[]): Promise<any> {
    const response = await fetch(`http://localhost:${this.options.port}/api/cli`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.options.token}`
      },
      body: JSON.stringify({ command, args })
    });

    if (!response.ok) {
      throw new Error(`CLI call failed: ${response.statusText}`);
    }

    return response.json();
  }

  async listServices(): Promise<string[]> {
    const response = await fetch(`http://localhost:${this.options.port}/api/services`, {
      headers: { 'Authorization': `Bearer ${this.options.token}` }
    });
    const data = await response.json();
    return data.services.map((s: any) => s.name);
  }

  async startService(name: string): Promise<void> {
    await fetch(`http://localhost:${this.options.port}/api/services/${name}/start`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.options.token}` }
    });
  }

  async stopService(name: string): Promise<void> {
    await fetch(`http://localhost:${this.options.port}/api/services/${name}/stop`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.options.token}` }
    });
  }

  async listSessions(): Promise<any[]> {
    const response = await fetch(`http://localhost:${this.options.port}/api/sessions`, {
      headers: { 'Authorization': `Bearer ${this.options.token}` }
    });
    const data = await response.json();
    return data.sessions;
  }

  async killSession(sessionId: string): Promise<void> {
    await fetch(`http://localhost:${this.options.port}/api/sessions/${sessionId}/kill`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.options.token}` }
    });
  }
}

// Singleton for test suite
let gatewayInstance: GatewayManager | undefined;

export async function startTestGateway(): Promise<GatewayManager> {
  if (gatewayInstance) {
    await gatewayInstance.stop();
  }

  gatewayInstance = new GatewayManager({
    profile: 'aof-e2e-test',
    port: 19003,
    token: 'test-token-12345',
    aofDataDir: join(process.env.HOME!, '.openclaw-aof-e2e-test', 'aof-test-data'),
    aofPluginPath: join(process.cwd(), 'dist', 'index.js'),
    verbose: process.env.VERBOSE_TESTS === 'true'
  });

  await gatewayInstance.start();
  return gatewayInstance;
}

export async function stopTestGateway(): Promise<void> {
  if (gatewayInstance) {
    await gatewayInstance.stop();
    await gatewayInstance.cleanup();
    gatewayInstance = undefined;
  }
}
```

### 5.3 Vitest E2E Configuration

```typescript
// tests/vitest.e2e.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/suites/**/*.test.ts'],
    testTimeout: 60_000,     // E2E tests can be slower
    hookTimeout: 30_000,     // Allow time for gateway startup
    globalSetup: './tests/e2e/setup/global-setup.ts',
    globalTeardown: './tests/e2e/setup/global-teardown.ts',
    // Run E2E tests sequentially (not parallel)
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  }
});
```

### 5.4 Package.json Scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "vitest run --config tests/vitest.e2e.config.ts",
    "test:e2e:watch": "vitest --config tests/vitest.e2e.config.ts",
    "test:e2e:verbose": "VERBOSE_TESTS=true vitest run --config tests/vitest.e2e.config.ts",
    "test:all": "npm run test && npm run test:e2e"
  }
}
```

---

## 6. CI/CD Integration (GitHub Actions)

### 6.1 GitHub Actions Workflow

```yaml
# .github/workflows/e2e-tests.yml
name: E2E Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  e2e-tests:
    runs-on: ubuntu-latest
    
    strategy:
      matrix:
        node-version: [22.x]
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build AOF
        run: npm run build
      
      - name: Install OpenClaw
        run: |
          npm install -g openclaw@2026.2.6
          openclaw --version
      
      - name: Run unit tests
        run: npm test
      
      - name: Run E2E tests
        run: npm run test:e2e
        env:
          CI: true
      
      - name: Upload test artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-test-failures
          path: tests/e2e/failures/
          retention-days: 7
      
      - name: Upload coverage
        if: always()
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage/coverage-final.json
```

### 6.2 Local Development Workflow

```bash
# Build AOF
npm run build

# Run unit tests
npm test

# Run E2E tests (all)
npm run test:e2e

# Run E2E tests (watch mode)
npm run test:e2e:watch

# Run E2E tests (verbose)
npm run test:e2e:verbose

# Run all tests
npm run test:all
```

---

## 7. Success Criteria

### 7.1 Functional Requirements
- ✅ All 9 Tier 1 E2E test scenarios pass
- ✅ Test execution time < 2 minutes for full suite
- ✅ Tests are deterministic (no flakiness)
- ✅ Tests run in CI without manual intervention

### 7.2 Non-Functional Requirements
- ✅ Test code follows TDD principles (test the harness itself)
- ✅ Test failures include actionable error messages
- ✅ Test artifacts (logs, state) preserved on failure
- ✅ Documentation includes "How to debug E2E test failures"

### 7.3 Acceptance Criteria
- ✅ swe-qa can run E2E tests locally without assistance
- ✅ CI pipeline runs E2E tests on every PR
- ✅ Test failures block merges to main
- ✅ E2E test coverage documented in README

---

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| OpenClaw lacks mock model provider | HIGH | Implement custom mock provider in tests/e2e/setup/mock-model.ts |
| OpenClaw plugin API changes in 2026.2.6 | MEDIUM | Version-pin OpenClaw, add API version assertions |
| Gateway startup timeout in CI | MEDIUM | Increase timeout, add retry logic, cache OpenClaw install |
| Test flakiness due to timing | MEDIUM | Use event-driven assertions (not fixed sleeps), add retries |
| State pollution between tests | LOW | Strict cleanup in beforeEach/afterEach hooks |

---

## 9. Timeline (Implementation by swe-qa)

### Phase 1: Foundation (Day 1-2)
- Set up E2E test directory structure
- Implement GatewayManager
- Implement test data seeding utilities
- Write first passing test (Plugin Registration)

### Phase 2: Core Tests (Day 3-5)
- Implement Tests 1.2-1.5 (Tool Execution, Dispatch Flow, Views, Resume)
- Add custom assertions and matchers
- Fix any OpenClaw integration issues discovered

### Phase 3: Endpoints & Advanced (Day 6-7)
- Implement Tests 1.6-1.9 (Metrics, Status, Concurrent Dispatch, Drift)
- Add Tier 2 robustness tests
- Performance tuning (reduce test execution time)

### Phase 4: CI/CD Integration (Day 8)
- GitHub Actions workflow
- Documentation (README, troubleshooting guide)
- Final review and merge

**Total Estimate: 8 days (assumes swe-qa full-time focus)**

---

## 10. References

- **AOF BRD:** `/Volumes/My Shared Files/openclaw-shared/AOF Project/AOF-BRD.md`
- **AOF Plugin Adapter:** `~/Projects/AOF/src/openclaw/adapter.ts`
- **OpenClaw CLI Docs:** `openclaw gateway --help`
- **Vitest Docs:** https://vitest.dev/
- **Current Unit Tests:** `~/Projects/AOF/src/**/__tests__/**/*.test.ts` (279 tests)

---

## Appendix A: Open Questions (Resolve Before Implementation)

1. ✅ **Does OpenClaw 2026.2.6 have a built-in mock model provider?**
   - ACTION: Test `openclaw --help` for mock provider options
   - FALLBACK: Implement custom mock provider

2. ✅ **What is the exact API for calling tools/CLIs via HTTP?**
   - ACTION: Inspect OpenClaw gateway source or API docs
   - FALLBACK: Use `openclaw` CLI directly via child_process

3. ✅ **How does OpenClaw load plugins?**
   - Assumption: Via `plugins` array in openclaw.json
   - ACTION: Verify with test config

4. ⚠️ **Can we programmatically spawn agents via API?**
   - If not, scheduler must handle this (existing behavior)

5. ⚠️ **How to detect when scheduler has processed a poll cycle?**
   - ACTION: Add `/aof/status` endpoint with `lastPollAt` timestamp
   - FALLBACK: Use fixed sleep (less robust)

---

**Document Status:** Ready for implementation. swe-qa should begin with Phase 1 immediately.
