> **Internal document** — context-specific details may not apply to general deployments.

# Agentic SDLC: PM Addendum — Flow, Operations, and Anti-Stall

**Version:** 1.0  
**Author:** PM (swe-pm)  
**Date:** 2026-02-16  
**Status:** Draft — Ready for Review  
**Companion to:** WORKFLOW-GATES-DESIGN.md

---

## Executive Summary

This document defines the **operational layer** of the agentic SDLC: how work flows through the gates, how we prevent stalls, what we measure, and how we continuously improve. The architect designed the gates; the PM makes them flow.

**Core PM responsibilities:**
- **Allocation:** Sprint planning and WIP limits for agent capacity
- **Velocity:** Anti-stall mechanisms and escalation cascades
- **Visibility:** Metrics, dashboards, and health reporting
- **Learning:** Retrospective automation and process improvement
- **Coordination:** Interface boundaries with PO and Architect
- **Optimization:** Lean flow principles and bottleneck detection

**Design principles:**
- **Concrete over abstract**: Specific timeouts, not "monitor for delays"
- **Automated over manual**: Escalation happens automatically, not via Slack ping
- **Observable over opaque**: Every metric has a threshold and action
- **Adaptive over rigid**: System learns from failures and adjusts

---

## 1. Sprint Planning Model for Agents

### 1.1 Allocation Strategy

**Primary model: Priority-based with capacity awareness**

Agents don't have "velocity" in the traditional sense (no story points, no historical burndown). Instead:

1. **Priority cascade:**
   - P0 (blocking): Always pulled first, preempt lower priority
   - P1 (important): Fill capacity after P0s exhausted
   - P2 (nice-to-have): Backfill only
   - P3 (future): Not allocated in current sprint

2. **Capacity model:**
   - Agent capacity = **concurrent tasks**, not hours/points
   - Default: 1 task per agent (single-threaded execution)
   - Specialized agents (QA, reviewer): up to 3 concurrent tasks (reviews are faster)
   - No agent gets 0 tasks unless marked unavailable

3. **Allocation algorithm (executed by scheduler):**
   ```
   FOR each priority level (P0 → P1 → P2):
     FOR each agent with capacity:
       IF agent.role matches available tasks at current gate:
         Assign highest-priority task matching role
         Decrement agent capacity
       IF no agents have capacity:
         BREAK (rest goes to backlog)
   ```

4. **Re-allocation on completion:**
   - Agent completes task → capacity freed immediately
   - Scheduler re-runs allocation (pull next task from backlog)
   - No waiting for "sprint boundary" — continuous flow

**Why priority-based?** Agents complete tasks in hours, not days. Capacity-based allocation (distributing N tasks evenly) doesn't work because:
- Task sizes vary wildly (30min review vs 8hr implementation)
- Agents finish at different times (no synchronization)
- Priority changes happen mid-"sprint" (P2 becomes P0)

**Why not velocity-based?** Agents don't estimate. Task sizing (section 1.2) is coarse-grained (fits in session or doesn't).

### 1.2 Task Sizing for Agents

**Hard constraint: Task must complete in a single session (~2-8 hours).**

**Sizing criteria:**

| Size | Duration | Characteristics | Examples |
|------|----------|----------------|----------|
| Small | 30m-2h | Single file, no dependencies | Add validation rule, write unit test |
| Medium | 2-4h | Multiple files, local scope | Implement endpoint, refactor module |
| Large | 4-8h | Cross-cutting, requires research | Design data model, integrate third-party API |
| Too Large | >8h | **SPLIT REQUIRED** | Build authentication system |

**Splitting large tasks:**
- PM decomposes "Too Large" tasks into subtasks before allocation
- Each subtask becomes independent task in backlog
- Subtasks have dependency links (task B blocks on task A)
- Subtasks share parent epic/feature for traceability

**How PM sizes tasks:**
1. Review task description and acceptance criteria
2. Estimate scope (files touched, complexity, unknowns)
3. If >8h: decompose into phases (implement → test → docs)
4. If unknowable: create spike task (time-boxed investigation, 2h max)

**Agent feedback loop:**
- If agent signals `blocked` with reason "scope too large", PM re-evaluates split
- If agent consistently exceeds session timeout, PM adjusts sizing calibration

**Tooling:**
```bash
# PM checks task size estimates
aof task estimate AOF-abc

# Output:
# Estimated complexity: Medium (3-5h)
# Based on: 3 files touched, 1 external dependency, medium test coverage
# Recommendation: Allocate to experienced backend agent
```

### 1.3 WIP Limits Per Agent

**Default limits (by role):**

| Role | Max Concurrent Tasks | Rationale |
|------|---------------------|-----------|
| Implementer (backend/frontend/etc) | 1 | Deep focus, context-heavy |
| Reviewer (architect/code-review) | 3 | Reviews are faster, parallelizable |
| Tester (QA) | 2 | Test execution can be batched |
| Specialist (security/data-arch) | 1 | Requires deep expertise, no multitasking |
| Human (PO/stakeholder) | 5 | Approval gates are async |

**Enforcement:**
- Scheduler checks `agent.activeTasks.length` before assignment
- If at limit, skip agent (assign to peer with same role)
- If all agents at limit, task waits in backlog

**Dynamic adjustment:**
- If agent consistently completes tasks <2h, increase limit to 2
- If agent frequently signals `blocked`, decrease limit to 1
- Adjustments logged and reviewed in retrospectives

**System-wide WIP limit:**
- Total active tasks ≤ (number of agents × average WIP limit)
- If exceeded, halt new task allocation until tasks complete
- Prevents overload when many tasks stuck at single gate

**Why these limits?**
- Implementers: Context switching kills productivity (code requires deep state)
- Reviewers: Approval is stateless, can interleave multiple reviews
- Humans: Approvals happen async (not bound to session duration)

### 1.4 Priority Changes Mid-Sprint

**Scenario:** P2 task becomes P0 (customer escalation, security incident, etc.)

**Handling:**

1. **Immediate re-prioritization:**
   - PM updates task priority in frontmatter
   - Scheduler detects priority change on next poll (60s max latency)
   - P0 task jumps to front of backlog queue

2. **Preemption policy (default: none):**
   - Agent currently working on P2 task continues (no mid-task interruption)
   - P0 task assigned to next available agent with matching role
   - If no agents available, P0 task waits (but at front of queue)

3. **Preemption policy (optional: aggressive):**
   - If P0 task arrives and all agents busy on P1/P2:
     - Scheduler signals agent with lowest-priority task to pause
     - Agent checkpoints work (saves partial state)
     - P0 task assigned to freed agent
     - Paused task returns to backlog with "resume" marker

4. **Communication:**
   - PM broadcasts priority change to project channel:
     ```
     🚨 AOF-abc escalated to P0: [reason]
     Expected ETA: 4h (currently in implement gate)
     ```

**When to use aggressive preemption:**
- Production incidents (P0 + tag:incident)
- Security vulnerabilities (P0 + tag:security)
- Customer-blocking issues (P0 + tag:customer)

**When NOT to preempt:**
- "Important but not urgent" P0s (wait for natural handoff)
- Task at final gate (let it complete, almost done anyway)

**Metrics to track:**
- `priority_changes_total{from, to}` — frequency of re-prioritization
- `preemptions_total` — how often we interrupt agents
- `preemption_waste_hours` — time lost to context switching

**Threshold:** If priority changes >10/week, PM investigates backlog grooming process (poor initial prioritization).

---

## 2. Anti-Stall Mechanisms

**PM's job: Keep work flowing. Detect stalls early, escalate automatically.**

### 2.1 Task Stuck at Gate (Escalation Cascade)

**Trigger:** Task in same gate for >threshold duration without completion.

**Thresholds by gate type:**

| Gate Type | Threshold | Escalation Action |
|-----------|-----------|------------------|
| Implement | 8 hours | Notify agent + PM review |
| Review | 4 hours | Assign to backup reviewer |
| Test | 6 hours | Check for test environment issues |
| Approval (human) | 24 hours | Notify approver + skip option |
| Approval (agent) | 4 hours | Assign to backup agent |

**Escalation cascade (example: code-review gate):**

```
T+0:    Task enters code-review gate (assigned to agent-3)
T+2h:   [No action] — within normal range
T+4h:   [Threshold hit]
        ↓
        1. Emit metric: gate_stall_warning{gate="code-review", task="AOF-abc"}
        2. Ping agent-3: "AOF-abc has been in review for 4h, ETA?"
        ↓
T+4h+15m: Agent responds "blocked on clarification" → mark as blocked, notify PM
T+4h+15m: Agent no response → proceed to step 3
        ↓
        3. Check if backup reviewer available (same role, different agent)
        4. If yes: Unassign from agent-3, assign to backup
        5. If no: Escalate to PM for manual intervention
        ↓
T+6h:   [Second threshold]
        6. PM receives alert: "AOF-abc stuck in code-review >6h"
        7. PM reviews task + gate history, decides:
           - Reassign to different reviewer
           - Skip gate (if non-critical and urgent)
           - Split task (too complex for single review)
```

**Implementation:**
- PM agent runs `aof-flow-monitor` daemon (separate process)
- Polls all active tasks every 5 minutes
- Compares `task.gate.entered` timestamp to current time
- If exceeded threshold, triggers escalation action
- Escalation actions logged to `escalations.jsonl`

**Escalation policy configuration:**
```yaml
# project.yaml
flow:
  stallDetection:
    gates:
      implement:
        warnAfter: 6h
        escalateAfter: 8h
        action: notify-pm
        
      code-review:
        warnAfter: 2h
        escalateAfter: 4h
        action: assign-backup
        
      approve:
        warnAfter: 12h
        escalateAfter: 24h
        action: notify-skip-option
```

**Why these thresholds?**
- Implement: 8h = one full work session (reasonable)
- Review: 4h = half-day (reviews should be quick)
- Approval: 24h = accounts for human async (not always online)

**Alert fatigue prevention:**
- Warnings don't repeat (one alert per threshold breach)
- If task legitimately needs >threshold (e.g., complex review), agent can extend:
  ```typescript
  await aof.extendDeadline({ reason: "Complex security review, need 2h more" })
  ```

### 2.2 Agent Fails Repeatedly

**Trigger:** Agent completes task, but work rejected N times at next gate.

**Thresholds:**
- 2 rejections: Warning (expected for complex tasks)
- 3 rejections: Alert PM + assign to different agent
- 5 rejections: Mark task as requiring human intervention

**Escalation logic:**

```
Task AOF-abc: implement → code-review
  Rejection #1: "Missing tests" → loop back to implement
  Agent completes again → code-review
  Rejection #2: "Tests still incomplete" → loop back
  [Warning] PM notified: "AOF-abc rejected twice, review needed"
  
  Agent completes again → code-review
  Rejection #3: "Architecture issues" → loop back
  [Action] Unassign from current agent, assign to senior agent
  
  Agent completes again → code-review
  Rejection #4: Still rejected
  [Action] PM reviews task, options:
    - Task too complex (split into subtasks)
    - Agent lacks context (provide more detailed AC)
    - Reviewer too strict (calibrate review criteria)
    
  If rejection #5: Mark as escalated, human PM takes over
```

**Root cause tracking:**
- Log rejection reasons per task: `rejectionReasons[]`
- If same reason repeated (e.g., "missing tests" 3x), PM knows agent isn't learning
- If different reasons each time, task scope likely unclear

**Mitigation strategies (PM chooses):**
1. **Agent swap:** Assign to different agent with same role
2. **Pairing:** Assign two agents (one implements, one shadows for learning)
3. **Scope clarification:** PM rewrites acceptance criteria with examples
4. **Review calibration:** PM talks to reviewer (are standards too high?)
5. **Task decomposition:** Split into smaller chunks

**Metrics:**
- `task_rejections_total{task, agent}` — per-task rejection count
- `agent_rejection_rate{agent}` — rejection frequency per agent
- `reviewer_rejection_rate{reviewer}` — how often reviewers reject

**Threshold:** If agent has >50% rejection rate over 10 tasks, PM triggers training/calibration review.

### 2.3 Whole Pipeline Slows Down

**Trigger:** System-wide throughput drops below baseline.

**Baseline metrics (established during healthy operation):**
- Tasks completed per day: 20-30 (example for AOF project)
- Average lead time (backlog → complete): 12-18 hours
- Average cycle time per gate: <2h (implement), <1h (review), <30m (approve)

**Slowdown detection:**
```
IF (rolling_7day_avg_throughput < baseline * 0.7):
  Emit alert: "Pipeline throughput down 30%"
  PM investigates bottleneck
```

**Investigation checklist:**

1. **Gate bottleneck analysis:**
   ```bash
   aof metrics gate-durations --last 7d
   
   # Output:
   # Gate: code-review — P95: 6h (baseline: 2h) ← BOTTLENECK
   # Gate: implement — P95: 8h (baseline: 8h)
   # Gate: test — P95: 1h (baseline: 1h)
   ```

2. **Agent availability check:**
   ```bash
   aof agents status --role architect
   
   # Output:
   # agent-3 (architect): 3/3 tasks assigned (AT LIMIT)
   # No other architects available ← CAPACITY ISSUE
   ```

3. **Task complexity trend:**
   ```bash
   aof metrics task-complexity --last 7d
   
   # Output:
   # Average task size: Large (6h) — up from Medium (4h) baseline
   # Hypothesis: Tasks not being split properly
   ```

4. **Rejection rate spike:**
   ```bash
   aof metrics rejection-rate --by-gate
   
   # Output:
   # code-review rejection rate: 45% (baseline: 25%) ← QUALITY ISSUE
   ```

**Intervention triggers:**

| Cause | Action |
|-------|--------|
| Single gate bottleneck | Add more agents to bottleneck role OR split tasks to bypass gate |
| Agent capacity exhausted | Recruit/activate more agents OR reduce backlog |
| Task complexity increasing | Enforce stricter splitting policy |
| Rejection rate spike | Calibrate reviewers OR improve AC quality |
| External blockers (API down, etc.) | Mark affected tasks as blocked, focus on unblocked work |

**Automated rebalancing:**
- If gate X has >50% of active tasks, scheduler temporarily assigns more agents to that role
- If role has no available agents, PM gets paged (manual scaling decision)

**Communication:**
- PM posts weekly flow report:
  ```
  📊 AOF Flow Report (Week of 2026-02-10)
  
  Throughput: 18 tasks/day (↓15% from baseline)
  Bottleneck: code-review gate (P95: 6h)
  Action: Recruiting backup reviewer
  
  Rejection rate: 30% (↑5% from baseline)
  Top reason: "Incomplete tests" (40% of rejections)
  Action: Updated test template in AGENTS.md
  
  Lead time: 20h (↑33% from baseline)
  Cause: Complex feature set this sprint
  Mitigation: Stricter task splitting next sprint
  ```

### 2.4 Automatic Backlog Grooming

**Problem:** Backlog grows stale (old tasks, changing priorities, blocked tasks never revisited).

**Automated grooming rules (run daily):**

1. **Stale task detection:**
   - Task in backlog >14 days without activity → tagged `stale`
   - PM reviews stale tasks weekly: keep, archive, or update priority

2. **Blocked task follow-up:**
   - Task marked `blocked` >7 days → check if blocker resolved
   - If blocker still present, reduce priority (P1 → P2)
   - If blocker resolved, mark as `ready` and re-prioritize

3. **Priority decay:**
   - P2 tasks in backlog >30 days → demote to P3
   - P3 tasks in backlog >90 days → archive (no longer relevant)

4. **Dependency resolution:**
   - Task B depends on task A (via `blockedBy` field)
   - When task A completes, scheduler auto-promotes task B to `ready`
   - If task A archived/canceled, PM notified to re-evaluate task B

**Grooming metrics:**
- `backlog_size{priority}` — how many tasks waiting at each priority
- `stale_tasks_total` — tasks >14 days old
- `blocked_tasks_total` — tasks with active blockers
- `avg_backlog_age_days` — how long tasks wait before starting

**Threshold:** If `avg_backlog_age_days` >7 for P0/P1 tasks, PM investigates capacity issue (not enough agents).

**Manual grooming (PM weekly):**
- Review top 20 backlog tasks
- Validate priorities still accurate
- Check for duplicate tasks (consolidate)
- Ensure all tasks have clear acceptance criteria

**Tooling:**
```bash
# PM runs grooming assistant
aof backlog groom --auto-stale --auto-decay

# Output:
# Marked 5 tasks as stale (>14 days)
# Demoted 3 P2 → P3 (>30 days)
# Archived 2 P3 tasks (>90 days)
# Promoted 4 tasks (blockers resolved)
```

### 2.5 Dead-Letter Handling

**Definition:** Task that cannot be completed despite multiple attempts.

**Criteria for dead-letter:**
- 5+ rejections with no progress
- 10+ days in active state (not blocked, just failing)
- Agent signals "cannot complete" 3+ times
- Circular loop detected (task bouncing between same 2 gates)

**Dead-letter workflow:**

```
1. PM agent detects dead-letter criteria
2. Task moved to dead-letter queue (special status: needs-intervention)
3. PM notified: "AOF-abc dead-lettered — human review required"
4. PM reviews:
   - Check gate history (what kept failing?)
   - Check rejection reasons (consistent or different?)
   - Check agent notes (what did they struggle with?)
5. PM decides:
   - Option A: Rewrite acceptance criteria (task was unclear)
   - Option B: Split task (too complex)
   - Option C: Assign to human (too creative/ambiguous for agent)
   - Option D: Cancel task (no longer needed)
6. Task exits dead-letter queue, re-enters backlog (or archived)
```

**Dead-letter metrics:**
- `dead_letter_total` — how many tasks end up here
- `dead_letter_resolution_time` — how long to resolve
- `dead_letter_causes{reason}` — categorized reasons (unclear AC, too complex, etc.)

**Threshold:** If >5% of tasks end up in dead-letter, PM reviews task creation process (poor initial scoping).

**Prevention:**
- Better task templates (force clear AC)
- Spike tasks for unknowns (don't let agents guess)
- Regular AC review (PO validates before allocation)

---

## 3. Metrics and Reporting

**PM tracks two classes of metrics: flow metrics (how fast?) and quality metrics (how good?).**

### 3.1 Accelerate Metrics (DORA)

**Deployment Frequency**
- **Definition:** How often code reaches production
- **AOF mapping:** Tasks that complete "deploy" gate (if exists) or final approval gate
- **Target:** ≥1 deploy/day (for AOF, "deploy" = merged to main)
- **Current:** Tracked via `gate_transitions_total{gate="deploy", outcome="complete"}`

**Lead Time for Changes**
- **Definition:** Time from "code committed" to "code in production"
- **AOF mapping:** Time from task `created` to task `complete` (spans all gates)
- **Target:** <24h for P0/P1 tasks, <7d for P2
- **Calculation:** `task.completedAt - task.createdAt`
- **Tracked per task in gateHistory:** `totalDuration` field

**Change Failure Rate**
- **Definition:** % of deployments causing production issues
- **AOF mapping:** Tasks that complete but get reopened with `tag:regression`
- **Target:** <15% (industry standard for high performers)
- **Calculation:** `reworked_tasks / completed_tasks`
- **Tracked:** `task_rework_total{reason}` metric

**Mean Time to Restore (MTTR)**
- **Definition:** Time to fix production issues
- **AOF mapping:** Time from incident task creation to completion
- **Target:** <1h for P0 incidents
- **Calculation:** Lead time for `tag:incident` tasks
- **Tracked:** `incident_resolution_time_seconds` metric

**Dashboard panel:**
```
DORA Metrics (Last 30d)
├─ Deployment Frequency: 1.2/day (↑10% vs last period)
├─ Lead Time (P0/P1): 18h (target: <24h) ✅
├─ Lead Time (P2): 5d (target: <7d) ✅
├─ Change Failure Rate: 12% (target: <15%) ✅
└─ MTTR (incidents): 45m (target: <1h) ✅
```

### 3.2 Gate-Specific Metrics

**Gate Duration (cycle time per gate)**
- **Metric:** `aof_gate_duration_seconds{gate, outcome}`
- **Aggregations:** P50, P95, P99 per gate
- **Purpose:** Identify slow gates
- **Alert:** P95 >2× baseline → investigate bottleneck

**Gate Rejection Rate**
- **Metric:** `aof_gate_rejections_total{gate, reason}`
- **Calculation:** `rejections / (rejections + approvals)`
- **Purpose:** Identify quality issues at specific gates
- **Target:** <30% per gate (some rejection is healthy, too much signals mismatch)

**Gate Transition Count**
- **Metric:** `aof_gate_transitions_total{from_gate, to_gate}`
- **Purpose:** Visualize flow (Sankey diagram: implement →[80%]→ review →[20%]→ implement)
- **Alert:** If any loop >50% of forward transitions, process broken

**Active Tasks per Gate**
- **Metric:** `aof_gate_active_tasks{gate}`
- **Purpose:** Real-time bottleneck visibility
- **Alert:** If one gate has >50% of all active tasks, rebalance

**Gate Skip Rate**
- **Metric:** `aof_gate_skips_total{gate, reason}`
- **Purpose:** Track conditional gate usage
- **Example:** If security gate skipped 90% of time, consider removing it (too broad condition)

### 3.3 Agent Performance Metrics

**Agent Throughput**
- **Metric:** `agent_tasks_completed_total{agent, role}`
- **Aggregation:** Tasks per day per agent
- **Purpose:** Identify high/low performers
- **Caveat:** Don't compare across roles (implementers vs reviewers have different task types)

**Agent Rejection Rate**
- **Metric:** `agent_rejection_rate{agent}`
- **Calculation:** `tasks_rejected / tasks_submitted`
- **Purpose:** Identify agents needing calibration
- **Alert:** >50% rejection → training needed

**Agent Cycle Time**
- **Metric:** `agent_task_duration_seconds{agent, gate}`
- **Aggregation:** P50 per agent
- **Purpose:** Identify fast/slow agents (for capacity planning)

**Agent WIP**
- **Metric:** `agent_active_tasks{agent}`
- **Purpose:** Real-time capacity check
- **Alert:** Agent exceeds WIP limit → scheduler bug

### 3.4 Rework Rate

**Definition:** % of tasks that loop back through gates due to rejection.

**Calculation:**
```
rework_rate = (tasks_with_rejections / total_completed_tasks) × 100
```

**Segmentation:**
- By gate (which gate rejects most?)
- By agent (which agent gets rejected most?)
- By task complexity (do large tasks get rejected more?)

**Target:** <40% (some rework expected, but majority should pass first time)

**High rework signals:**
- Unclear acceptance criteria (PO problem)
- Poor initial implementation (agent training problem)
- Overly strict review (reviewer calibration problem)

### 3.5 Dashboard Design

**Primary dashboard (Grafana):**

**Row 1: Flow Health**
- Lead time trend (line graph, last 30d)
- Throughput (tasks/day, bar chart)
- Active tasks by gate (stacked bar)
- Backlog size by priority (gauge)

**Row 2: Bottleneck Detection**
- Gate duration heatmap (P95 per gate, color-coded)
- Gate rejection rate (bar chart)
- Tasks stuck >threshold (table with task IDs)

**Row 3: Agent Performance**
- Agent throughput (bar chart, tasks/day per agent)
- Agent rejection rate (bar chart)
- Agent WIP utilization (gauge per agent)

**Row 4: Quality Signals**
- Rework rate trend (line graph)
- Rejection reasons (pie chart, top 5)
- Dead-letter queue size (gauge)

**Row 5: DORA**
- Deployment frequency (stat)
- Lead time (stat)
- Change failure rate (stat)
- MTTR (stat)

**Auto-refresh:** Every 60s (real-time operational view)

### 3.6 Periodic Reporting

**Daily standup report (automated):**
```
🤖 AOF Daily Flow Report — 2026-02-16

Yesterday:
  ✅ 22 tasks completed
  ⏱️ Lead time: 14h (P50)
  🔄 Rework rate: 28%
  
Today's focus:
  🎯 18 tasks in progress
  🚧 Bottleneck: code-review (8 tasks waiting)
  
Alerts:
  ⚠️ AOF-abc stuck in implement >8h
  ⚠️ agent-7 rejection rate 60% (last 5 tasks)
  
Action items:
  - PM to review AOF-abc (potential split)
  - PM to calibrate agent-7 with reviewer feedback
```

**Weekly retrospective report:**
```
📊 AOF Weekly Retrospective — Week of 2026-02-10

Flow metrics:
  Throughput: 130 tasks (avg 18.5/day)
  Lead time: P50=16h, P95=36h
  Rework rate: 32% (↑7% vs last week)
  
Top bottlenecks:
  1. code-review gate: P95=6h (2× baseline)
  2. Security gate: 50% rejection rate
  
Top rejections:
  1. "Incomplete tests" — 35% of all rejections
  2. "Missing error handling" — 20%
  3. "Poor variable naming" — 15%
  
Agent highlights:
  🏆 agent-12: 25 tasks, 0 rejections
  📈 agent-qa-2: Improved from 40% to 20% rejection rate
  ⚠️ agent-7: 55% rejection rate (training scheduled)
  
Process improvements:
  ✅ Added test template to AGENTS.md
  ✅ Security checklist for auth tasks
  🔄 Piloting pair programming for complex tasks
  
Next week focus:
  - Reduce code-review backlog (recruit backup reviewer)
  - Target <25% rework rate (better AC from PO)
```

**Monthly executive summary:**
```
📈 AOF Monthly Report — February 2026

DORA Metrics:
  Deployment Frequency: 1.3/day ✅ (target: ≥1/day)
  Lead Time: 18h ✅ (target: <24h)
  Change Failure Rate: 14% ✅ (target: <15%)
  MTTR: 52m ✅ (target: <1h)
  
Velocity trend: ↑12% vs January
  
Key learnings:
  - Stricter task splitting reduced avg lead time by 20%
  - Added backup reviewers eliminated code-review bottleneck
  - Test template reduced "incomplete tests" rejections by 40%
  
Challenges:
  - Security gate still high rejection (50%) — working with security team on calibration
  - Agent-7 underperforming — additional training provided
  
Q1 goals:
  - Maintain DORA green across all metrics
  - Reduce rework rate to <25%
  - Achieve 20 tasks/day sustained throughput
```

### 3.7 Metric-Driven Process Improvement

**How metrics inform decisions:**

| Metric Signal | Hypothesis | Action |
|---------------|-----------|--------|
| Lead time increasing | Tasks getting more complex OR bottleneck forming | Check gate durations; split large tasks |
| Rejection rate >40% | AC unclear OR agent skill gap | PO reviews AC; PM calibrates agents |
| Agent A rejection 2× peer avg | Agent needs training OR mismatched role | Pair with senior agent; check role fit |
| Gate X duration 3× baseline | Not enough agents OR gate too strict | Add capacity OR relax gate criteria |
| Rework rate increasing | Quality slipping OR process broken | Root cause analysis; fix upstream gate |
| Backlog growing | Demand > capacity OR poor prioritization | Add agents OR reduce scope |

**Improvement cadence:**
- **Daily:** React to alerts (stuck tasks, bottlenecks)
- **Weekly:** Analyze trends, small adjustments (templates, checklists)
- **Monthly:** Major process changes (new gates, role rebalancing)
- **Quarterly:** Strategic changes (agent recruitment, workflow redesign)

---

## 4. Retrospective Automation

**Problem:** Agents don't attend standups. How do we learn from failures?

### 4.1 Automated Retrospective Collection

**Data sources:**
1. **Gate history logs** (`gateHistory[]` in task frontmatter)
2. **Rejection reasons** (structured `blockers[]` field)
3. **Agent completion notes** (free-text `summary` field)
4. **Telemetry** (Prometheus metrics, event stream)

**Retrospective aggregation (runs weekly):**

```typescript
// Pseudo-code for retro agent
async function generateRetrospective() {
  const completedTasks = await loadTasks({ 
    status: "complete", 
    completedAfter: lastWeek 
  });
  
  const analysis = {
    // What went well?
    wins: findHighPerformers(completedTasks), // 0 rejections, <baseline lead time
    
    // What went wrong?
    struggles: {
      highRejectionTasks: completedTasks.filter(t => t.gateHistory.filter(g => g.outcome === "needs_review").length > 2),
      stuckTasks: completedTasks.filter(t => t.leadTime > baseline * 1.5),
      deadLetters: await loadDeadLetterTasks()
    },
    
    // Patterns
    rejectionReasons: aggregateRejectionReasons(completedTasks),
    bottleneckGates: findSlowGates(completedTasks),
    agentPerformance: aggregateAgentMetrics(completedTasks)
  };
  
  return generateReport(analysis);
}
```

**Output:** Structured retrospective document (`retros/2026-02-week07.md`)

### 4.2 Rejection Pattern Analysis

**Question:** Which gates reject most? Why?

**Analysis:**

```sql
-- Top gates by rejection count (pseudo-SQL over JSONL logs)
SELECT 
  gate,
  COUNT(*) as rejections,
  AVG(loop_count) as avg_loops
FROM gate_history
WHERE outcome = 'needs_review'
GROUP BY gate
ORDER BY rejections DESC
LIMIT 5;

-- Output:
-- code-review: 45 rejections, 1.8 avg loops
-- security: 23 rejections, 2.1 avg loops
-- test: 12 rejections, 1.3 avg loops
```

**Rejection reason clustering:**
```
Top rejection reasons (code-review gate):
  1. "Incomplete tests" — 40% of rejections
  2. "Missing error handling" — 25%
  3. "Poor code style" — 20%
  4. Other — 15%
```

**Insight:** If "incomplete tests" dominates, solution is upstream (better test template, clearer AC).

**Automated recommendation:**
```
🤖 Recommendation: 40% of code-review rejections are "Incomplete tests"

Suggested actions:
  1. Add test coverage requirement to AGENTS.md (backend role)
  2. Create test template with examples
  3. Add "minimum test coverage" to acceptance criteria template
  
Estimated impact: Reduce test-related rejections by 50%
```

### 4.3 Agent-Specific Retrospectives

**Question:** Which agents struggle? What patterns?

**Analysis:**

```typescript
// Per-agent report card
const agentReport = {
  agent: "agent-7",
  role: "backend",
  tasks_completed: 18,
  rejection_rate: 55%, // ⚠️ high
  avg_lead_time: 22h,   // ⚠️ above baseline (18h)
  
  common_rejection_reasons: [
    "Incomplete tests" — 8 occurrences,
    "Missing validation" — 5 occurrences
  ],
  
  improvement_trend: "↓10% vs last week" // getting better
};
```

**Recommendation engine:**
```
Agent agent-7 underperforming:
  - Rejection rate 2.2× team average
  - Common issue: test coverage
  
Suggested actions:
  1. Pair with agent-12 (0% rejection rate) for next 3 tasks
  2. Review backend test template together
  3. Re-evaluate after 5 tasks
  
If no improvement: Consider role reassignment or additional training
```

### 4.4 Feeding Learnings Back to Agent Prompts

**Problem:** Agents repeat same mistakes (don't learn from rejections).

**Solution:** Update agent context files with learnings.

**Example workflow:**

1. **Retrospective identifies pattern:**
   ```
   50% of security rejections: "Missing input sanitization"
   ```

2. **PM updates `AGENTS.md` for backend role:**
   ```diff
   # Backend Implementation Checklist
   - [ ] Write unit tests (coverage ≥80%)
   + [ ] Sanitize all user inputs (XSS, SQLi)
   + [ ] Validate input types and ranges
   - [ ] Handle error cases
   ```

3. **PM adds example to context:**
   ```markdown
   ## Common Rejection Reasons (Learn From Past Mistakes)
   
   ### "Missing input sanitization" (Security Gate)
   - **Problem:** User input passed directly to database/HTML
   - **Example:** `db.query(\`SELECT * FROM users WHERE id=${req.params.id}\`)`
   - **Fix:** Use parameterized queries or ORM
   - **Code:**
     ```typescript
     db.query('SELECT * FROM users WHERE id=?', [req.params.id])
     ```
   ```

4. **Agent sees updated context on next task**
   - Backend agents now have sanitization checklist
   - Security rejections for this reason drop by 80%

**Feedback loop cadence:**
- **Weekly:** Update checklists/templates based on rejection patterns
- **Monthly:** Major agent context revisions (if process changed)
- **Quarterly:** Review all agent context for staleness/relevance

**Tracking effectiveness:**
```bash
# Did context update reduce rejections?
aof metrics rejection-reason --reason "Missing input sanitization" --before 2026-02-01 --after 2026-02-15

# Output:
# Before update: 12 occurrences
# After update: 2 occurrences
# ↓ 83% reduction — context update effective ✅
```

### 4.5 Quarterly Process Improvement Recommendations

**PM generates quarterly report with strategic recommendations.**

**Structure:**

```markdown
# Q1 2026 Process Improvement Report

## Executive Summary
- Completed 1,200 tasks (avg 13/day)
- Lead time: 18h (on target)
- Rework rate: 28% (needs improvement)

## Key Findings

### 1. Code Review Bottleneck
- **Observation:** 60% of lead time spent in code-review gate
- **Root cause:** Only 1 architect for 10 backend agents
- **Recommendation:** Train 2 senior backend agents as backup reviewers
- **Expected impact:** Reduce code-review P95 from 6h to 2h

### 2. Test Coverage Rejections
- **Observation:** 35% of rejections due to incomplete tests
- **Root cause:** No automated coverage check before review
- **Recommendation:** Add pre-review gate with automated coverage check (80% threshold)
- **Expected impact:** Reduce test-related rejections by 50%

### 3. Security Gate Underutilized
- **Observation:** Security gate skipped 85% of time (conditional: `tags.includes('security')`)
- **Root cause:** Agents not tagging security-relevant tasks
- **Recommendation:** Auto-tag tasks touching auth/PII/payments (keyword detection)
- **Expected impact:** Increase security review coverage to 40% of tasks

### 4. Agent Training Gaps
- **Observation:** 3 agents with >50% rejection rate (agent-7, agent-14, agent-22)
- **Root cause:** Insufficient onboarding, learning from repetition
- **Recommendation:** Implement agent pairing program (struggling agent shadows high performer)
- **Expected impact:** Reduce underperformer rejection rate to <30%

## Proposed Workflow Changes

### Change 1: Add Automated Pre-Review Gate
**Current:**
```yaml
gates:
  - id: implement
  - id: code-review
```

**Proposed:**
```yaml
gates:
  - id: implement
  - id: automated-checks  # NEW
    role: ci-agent
    description: "Run linter, tests, coverage check"
  - id: code-review
```

**Rationale:** Catch mechanical issues before human review (faster feedback, less reviewer load)

### Change 2: Split Complex Tasks Automatically
**Current:** PM manually identifies large tasks for splitting

**Proposed:** Scheduler detects tasks with >8h estimated duration, auto-creates subtasks

**Implementation:** Spike task for PM agent to build task-splitting heuristic

## Success Metrics for Q2
- Rework rate: Target <20% (current: 28%)
- Code-review P95: Target <2h (current: 6h)
- Security coverage: Target 40% (current: 15%)
- Agent rejection rate: No agent >40% (current: 3 agents >50%)

## Budget/Resources Needed
- 2 agent licenses for backup reviewers ($X/month)
- 20h PM time for agent pairing program setup
- 10h eng time for automated pre-review gate implementation
```

**Review process:**
- PM drafts quarterly report
- PO reviews strategic recommendations (align with product goals?)
- Architect reviews technical recommendations (feasible?)
- Lead architect approves process changes
- PM implements approved changes in Q2

**Tracking improvement:**
- Compare Q2 metrics to Q1 baseline
- Validate recommendations had expected impact
- Document learnings for Q3 planning

---

## 5. Coordination with PO and Architect

**PM owns "when and flow" — but interfaces with PO (what) and Architect (how).**

### 5.1 Role Boundaries

| Role | Owns | Decision Rights | Does NOT Own |
|------|------|-----------------|--------------|
| **PO (Product Owner)** | What to build, why, priority | Accept/reject features, change scope | How to build, when to ship, task decomposition |
| **Architect** | How to build, system design | Technical standards, gate definitions | What features, task priority, agent assignments |
| **PM (Product Manager)** | When to build, flow optimization | Task allocation, WIP limits, escalations | Feature requirements, architecture decisions |

**Three-way collaboration:**
```
PO defines feature → Architect designs approach → PM schedules work
         ↓                      ↓                        ↓
    Requirements            Standards                Schedule
         ↓                      ↓                        ↓
    Acceptance          Gate definitions            Allocation
     Criteria              & checklists              & flow
```

### 5.2 PO ↔ PM Interface

**PO responsibilities:**
- Write product requirements (BRDs, user stories)
- Define acceptance criteria (pass/fail conditions)
- Prioritize backlog (P0/P1/P2/P3)
- Accept completed features (final approval gate)

**PM responsibilities:**
- Decompose features into agent-sized tasks
- Sequence tasks (dependencies, priorities)
- Allocate tasks to agents
- Report progress (ETA, blockers)

**Collaboration touchpoints:**

1. **Feature intake (async):**
   - PO writes feature in backlog: `features/AOF-auth.md`
   - PM reviews: "Is this splittable? Dependencies? Estimate?"
   - PM decomposes into tasks: `tasks/AOF-abc.md`, `tasks/AOF-abd.md`
   - PM updates roadmap with ETA

2. **Priority changes (real-time):**
   - PO: "P2 feature needs to be P0 (customer request)"
   - PM: Checks impact (can we preempt? how much delay to other work?)
   - PM: Communicates trade-off: "P0 now means P1-feature-X delayed 2 days"
   - PO: Confirms decision
   - PM: Executes re-prioritization

3. **Acceptance gate (end of workflow):**
   - Task reaches "approve" gate (role: po)
   - PO reviews: Does it meet acceptance criteria?
   - PO approves (outcome: complete) or rejects (outcome: needs_review)
   - If rejected: Loops back to implement with PO's feedback

**Communication cadence:**
- Daily: PM sends progress update to PO (tasks completed, ETA for features)
- Weekly: PO + PM sync on backlog (new features, priority changes)
- Monthly: PO + PM + Architect review roadmap (capacity planning, scope adjustments)

**Conflict resolution:**
```
Scenario: PO wants to add P0 feature, but PM has no capacity

PO: "This is customer-critical, must start today"
PM: "All agents at capacity, earliest start: 2 days"
Options:
  A. PO de-prioritizes existing P1 work (makes room)
  B. PM recruits additional agent (increases capacity)
  C. PO accepts 2-day delay
  D. Escalate to project lead (executive decision)

Decision: Documented in project log, communicated to team
```

### 5.3 Architect ↔ PM Interface

**Architect responsibilities:**
- Define workflow gates (what gates exist, in what order)
- Set quality standards (review criteria, test coverage, etc.)
- Review technical work (code-review gate)
- Maintain architectural principles

**PM responsibilities:**
- Ensure gates are staffed (enough reviewers for review gates)
- Monitor gate health (which gates are bottlenecks?)
- Propose gate changes based on flow data (add/remove/reorder gates)

**Collaboration touchpoints:**

1. **Workflow design (upfront):**
   - Architect drafts workflow gates in `project.yaml`
   - PM reviews: "Are these gates staffed? Will this flow?"
   - PM proposes adjustments: "Add backup reviewer role for code-review gate"
   - Architect approves workflow config

2. **Gate calibration (ongoing):**
   - PM: "Code-review gate has 60% rejection rate, is this expected?"
   - Architect reviews rejection reasons: "Standards too strict? AC unclear?"
   - Architect adjusts review checklist or works with PO on better AC

3. **Bottleneck resolution (reactive):**
   - PM: "Code-review gate is bottleneck, P95=6h"
   - Architect: Options:
     - Train backup reviewers (add capacity)
     - Add automated pre-review gate (reduce review load)
     - Relax review standards (faster but riskier)
   - PM + Architect decide, implement change

4. **Process improvement (quarterly):**
   - PM presents flow metrics: "Here's where we're slow, where we reject most"
   - Architect proposes technical solutions: "Add automated checks, split gates"
   - PM evaluates feasibility: "Will this improve flow? Cost/benefit?"
   - Architect implements approved changes

**Communication cadence:**
- Daily: PM alerts Architect to stuck tasks (e.g., "AOF-abc failing code-review 3x")
- Weekly: PM + Architect review gate health metrics
- Monthly: PM + Architect + PO review workflow effectiveness
- Quarterly: Major workflow redesigns (add/remove gates, change standards)

**Conflict resolution:**
```
Scenario: Architect wants to add security gate (more quality), PM concerned about throughput

Architect: "Security gate is critical for compliance"
PM: "Will increase lead time by 20%, impact customer SLA"
Options:
  A. Add gate but make it conditional (only for auth/payments)
  B. Add gate but train more security reviewers (minimize impact)
  C. Add automated security checks instead (faster than human review)
  D. Accept risk, don't add gate (Architect must approve)

Decision: Architect + PM + PO decide together (quality vs. speed trade-off)
```

### 5.4 Three-Way Backlog Grooming

**Problem:** Backlog needs input from all three roles (PO, Architect, PM).

**Grooming workflow (weekly):**

1. **PO prepares backlog:**
   - Reviews new feature requests
   - Writes requirements and acceptance criteria
   - Assigns initial priorities

2. **Architect reviews technical feasibility:**
   - Identifies technical dependencies (need API X first)
   - Flags architectural risks (needs design spike)
   - Estimates complexity (simple/medium/complex)

3. **PM reviews schedulability:**
   - Checks if tasks are agent-sized (<8h)
   - Proposes task splitting where needed
   - Estimates capacity (can we do this next sprint?)

4. **Three-way discussion:**
   - PO: "I need feature X by end of month"
   - Architect: "Feature X depends on refactor Y (5 days)"
   - PM: "We have capacity for X or Y, not both"
   - Resolution: PO decides priority, PM schedules accordingly

**Grooming outputs:**
- Refined backlog (clear AC, sized tasks, dependencies mapped)
- Updated roadmap (ETA for features)
- Risk log (technical risks, capacity constraints)

**Anti-patterns to avoid:**
- PO writing technical tasks (overstepping → Architect's job)
- Architect prioritizing features (overstepping → PO's job)
- PM rejecting features as "too hard" (overstepping → Architect decides feasibility)

**Boundary respect:**
- PO questions feasibility → asks Architect, doesn't decide
- Architect questions priority → asks PO, doesn't decide
- PM questions requirements → asks PO, doesn't rewrite

---

## 6. Flow Optimization (Lean Principles)

**PM applies Lean manufacturing principles to agentic SDLC.**

### 6.1 Minimize Work in Progress (WIP)

**Problem:** Too much WIP = context switching, long lead times, low throughput.

**Lean principle:** "Stop starting, start finishing."

**Implementation:**

1. **System-wide WIP cap:**
   - Max active tasks = 1.5 × number of agents
   - If exceeded, halt new task allocation until tasks complete
   - Example: 10 agents → max 15 active tasks

2. **Per-gate WIP cap:**
   - No gate should hold >30% of active tasks
   - If gate X exceeds cap, no new tasks enter that gate (queue upstream)
   - Forces bottleneck visibility

3. **Per-agent WIP limit:**
   - See section 1.3 (1 task for implementers, 3 for reviewers)

**Why WIP caps matter:**
- Lower WIP = faster task completion (Little's Law: Lead Time = WIP / Throughput)
- Lower WIP = fewer context switches (agents focus on one thing)
- Lower WIP = earlier feedback (don't wait until 50 tasks done to find issues)

**Monitoring:**
```bash
aof metrics wip

# Output:
# System WIP: 12/15 (80% of cap)
# Per-gate WIP:
#   implement: 4/5 (80%)
#   code-review: 6/5 (⚠️ OVER CAP)
#   test: 2/5 (40%)
# Action: Halt new tasks until code-review clears
```

**Trade-off:** WIP caps can starve upstream gates (implement agents idle while review is blocked). PM must balance caps with agent utilization.

### 6.2 Maximize Throughput

**Problem:** Agents sitting idle while backlog has work.

**Lean principle:** "Maximize flow efficiency."

**Implementation:**

1. **Pull-based scheduling:**
   - Agent completes task → immediately pulls next from backlog (no waiting)
   - No "batch assignments" (waiting for sprint boundary)

2. **Role flexibility:**
   - If agent's primary role has no work, can they do adjacent role?
   - Example: Backend agent helps with frontend tasks (if skilled)
   - Requires skill matrix in org chart

3. **Priority inversion prevention:**
   - Don't let low-priority tasks block high-priority (priority queue)
   - If P0 task waiting for agent, preempt P2 task (section 1.4)

4. **Minimize wait time:**
   - Automate where possible (pre-review checks, automated approvals)
   - Batch approvals (human approvers review multiple tasks at once)

**Throughput metrics:**
- Tasks completed per day (higher = better)
- Agent utilization % (% of time agent has active task)
- Idle time per agent (hours with no assigned work)

**Target:** >80% agent utilization (20% slack for unexpected P0s)

### 6.3 Reduce Wait Time

**Problem:** Tasks spend more time waiting than being worked on.

**Lean principle:** "Eliminate non-value-add time."

**Analysis:**

```
Task AOF-abc lifecycle:
  Backlog wait: 2h
  Implement: 4h (value-add)
  Code-review wait: 3h
  Code-review: 30m (value-add)
  Test wait: 1h
  Test: 1h (value-add)
  Approve wait: 8h (human async)
  Approve: 5m (value-add)
  
Total lead time: 19h 35m
Value-add time: 5h 35m (28%)
Wait time: 14h (72%) ← TARGET FOR REDUCTION
```

**Reduction strategies:**

1. **Reduce backlog wait:**
   - Add more agents (increase capacity)
   - Reduce WIP (clear active tasks faster)

2. **Reduce gate wait:**
   - Ensure gates are staffed (no single reviewer bottleneck)
   - Batch reviews (reviewer processes multiple tasks in one session)

3. **Reduce approval wait (human gates):**
   - Set SLA for human approvals (24h max)
   - Auto-approve low-risk tasks (conditional: `if tags.includes('low-risk') && all_tests_pass`)
   - Batch approvals (send digest of pending approvals daily)

**Target:** <50% wait time (value-add time ≥50% of lead time)

### 6.4 Bottleneck Detection and Rebalancing

**Theory of Constraints:** System throughput limited by slowest gate.

**Detection:**

```bash
aof metrics bottleneck-analysis

# Output:
# Gate P95 Duration (target <2h):
#   implement: 1.5h ✅
#   code-review: 6h ⚠️ ← BOTTLENECK
#   test: 1h ✅
#   approve: 0.5h ✅
#
# Active tasks by gate:
#   implement: 2 (20%)
#   code-review: 7 (70%) ← BOTTLENECK
#   test: 1 (10%)
#
# Recommendation: Add capacity to code-review gate
```

**Rebalancing actions:**

1. **Add agents to bottleneck role:**
   - Train existing agents to do reviews
   - Recruit external reviewers (humans or other agents)

2. **Reduce bottleneck load:**
   - Add automated pre-review (catch issues before human review)
   - Relax review standards (faster but riskier)

3. **Parallelize work:**
   - Split tasks into smaller chunks (multiple reviewers can work in parallel)
   - Example: Instead of reviewing entire feature, review per-component

4. **Bypass bottleneck (conditional):**
   - Skip review gate for low-risk tasks (`when: "!tags.includes('skip-review')"`)
   - Auto-approve if automated checks pass

**Monitoring:**
- Bottleneck should shift over time (as you fix one, another appears)
- If same gate is bottleneck >4 weeks, structural issue (not enough agents in that role)

### 6.5 Small Batch Sizes

**Problem:** Large tasks take forever, delay feedback, increase risk.

**Lean principle:** "Small batches = fast feedback = lower risk."

**Implementation:**

1. **Task splitting policy (section 1.2):**
   - Tasks >8h must be split
   - Prefer 2-4h tasks (sweet spot)

2. **Feature decomposition:**
   - Instead of "Build auth system" (5 days), split into:
     - Implement login endpoint (4h)
     - Implement JWT middleware (3h)
     - Add password hashing (2h)
     - Write auth tests (3h)
     - Write auth docs (1h)

3. **Incremental delivery:**
   - Deliver each subtask independently (merge to main)
   - Feature flag incomplete features (ship code, enable later)
   - Allows partial progress (1/5 done vs 0/1 done)

**Benefits:**
- Faster feedback (reviewer sees login endpoint in 4h, not auth system in 5 days)
- Lower risk (small change easier to test, rollback)
- Better parallelization (5 agents can work on 5 subtasks simultaneously)

**Trade-off:** Overhead of splitting (coordination, integration). PM must balance.

**Heuristic:**
- If task uncertainty is high (unknowns), prefer smaller batches (fail fast)
- If task is well-understood, batch size can be larger (less overhead)

### 6.6 Handling Dependencies Without Waterfall

**Problem:** Task B depends on task A. Traditional approach: wait for A to complete before starting B (waterfall).

**Lean approach:** Minimize wait, parallelize where possible.

**Strategies:**

1. **Stub dependencies:**
   - Task B starts with mocked version of task A's output
   - Task A completes → Task B swaps mock for real implementation
   - Allows parallel work

2. **Pipeline dependencies:**
   - Task A has subtasks A1, A2, A3
   - Task B depends only on A1 (not entire A)
   - Task B starts after A1 completes, while A2/A3 in progress

3. **Invert dependencies:**
   - Instead of B depends on A, refactor so A and B depend on shared interface C
   - Implement C first (small), then A and B in parallel

4. **Accept rework:**
   - Task B starts with assumption about A's output
   - If assumption wrong when A completes, B gets reworked (small cost)
   - Faster than waiting for A to complete first

**Dependency tracking:**
```yaml
# Task B frontmatter
id: AOF-abd
title: Implement password reset
blockedBy:
  - AOF-abc  # Task A must complete first
  
# When task A completes:
# Scheduler detects dependency resolved
# Task B auto-promoted to "ready" status
# Agent assigned immediately
```

**PM responsibilities:**
- Map dependencies during backlog grooming
- Identify opportunities to parallelize (stub, pipeline, invert)
- Monitor dependency chains (if >3 levels deep, likely waterfall)

**Metric:**
- `dependency_wait_time` — how long tasks wait on blockers
- Target: <10% of total lead time

---

## 7. Operational Runbook

**Quick reference for PM's day-to-day operations.**

### 7.1 Morning Routine

**8:00 AM — Check overnight progress**
```bash
aof metrics daily-summary

# Review:
# - Tasks completed yesterday
# - Tasks stuck >8h (investigate)
# - Bottleneck gates (rebalance if needed)
```

**8:15 AM — Check alerts**
```bash
aof alerts list --unacknowledged

# Action:
# - Stuck tasks → investigate (section 2.1)
# - Agent rejections >50% → calibrate (section 2.2)
# - Pipeline slowdown → bottleneck analysis (section 2.3)
```

**8:30 AM — Send daily standup report**
```bash
aof report daily --broadcast project-channel

# Automated message to team (PO, Architect, stakeholders)
```

### 7.2 Midday Routine

**12:00 PM — Backlog health check**
```bash
aof backlog status

# Check:
# - Backlog size (growing or shrinking?)
# - Stale tasks (>14 days old)
# - Blocked tasks (follow up on blockers)
```

**12:30 PM — Agent capacity check**
```bash
aof agents utilization

# Check:
# - Any agents idle? (assign work)
# - Any agents over WIP limit? (bug in scheduler?)
# - Any roles with no agents? (gate blocked)
```

### 7.3 End-of-Day Routine

**5:00 PM — Review escalations**
```bash
aof escalations list --today

# For each escalation:
# - Was it resolved?
# - Does it need manual intervention?
# - Update escalation log
```

**5:30 PM — Prepare tomorrow's priorities**
```bash
aof backlog top --priority P0,P1 --limit 20

# Ensure top-priority tasks have:
# - Clear acceptance criteria
# - No blockers
# - Correct role assignment
```

### 7.4 Weekly Routine

**Friday 2:00 PM — Generate retrospective report**
```bash
aof report retro --week $(date +%Y-W%V)

# Review:
# - What went well?
# - What went wrong?
# - Process improvements for next week
```

**Friday 3:00 PM — Backlog grooming with PO + Architect**
- Review top 20 backlog items
- Validate priorities
- Split large tasks
- Map dependencies

**Friday 4:00 PM — Update roadmap**
```bash
aof roadmap update --based-on velocity

# Adjust ETAs for features based on this week's throughput
```

### 7.5 Monthly Routine

**Last Friday of month — Generate monthly report**
```bash
aof report monthly --month $(date +%Y-%m)

# Review with PO + Architect:
# - DORA metrics
# - Velocity trends
# - Process improvements implemented
# - Goals for next month
```

**Last Friday of month — Agent performance review**
```bash
aof agents performance-review --month $(date +%Y-%m)

# For each agent:
# - Throughput (tasks/day)
# - Rejection rate
# - Areas for improvement
# - Training needs
```

### 7.6 Quarterly Routine

**Last week of quarter — Generate quarterly report (section 4.5)**
```bash
aof report quarterly --quarter Q1-2026

# Present to leadership:
# - Major accomplishments
# - Flow metrics trends
# - Strategic process improvements
# - Goals for next quarter
```

---

## 8. Appendix: PM Metrics Reference

### 8.1 Core Metrics (Track Daily)

| Metric | Definition | Target | Alert Threshold |
|--------|-----------|--------|-----------------|
| Throughput | Tasks completed/day | ≥15 | <10/day |
| Lead Time (P50) | Backlog → complete | <24h | >36h |
| WIP | Active tasks | ≤15 | >20 |
| Backlog Size | Ready tasks | <50 | >100 |
| Stuck Tasks | In gate >8h | 0 | >3 |

### 8.2 Quality Metrics (Track Weekly)

| Metric | Definition | Target | Alert Threshold |
|--------|-----------|--------|-----------------|
| Rework Rate | Tasks with rejections | <30% | >40% |
| Rejection Rate (by gate) | Rejections / submissions | <30% | >50% |
| Dead-Letter Rate | Tasks needing intervention | <5% | >10% |
| Agent Rejection Rate | Per-agent rejections | <40% | >60% (any agent) |

### 8.3 Flow Metrics (Track Weekly)

| Metric | Definition | Target | Alert Threshold |
|--------|-----------|--------|-----------------|
| Gate Duration (P95) | Time in each gate | <2h (review), <8h (implement) | >2× baseline