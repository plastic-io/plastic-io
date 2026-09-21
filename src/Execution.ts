import Scheduler from "./Scheduler";
import {newId, SchedulerEvent, ExecutionResult} from "./Shared";
import {CancellationToken} from "./Cancellation";
export {ExecutionCancelled, CancellationToken} from "./Cancellation";

/**
 * # Executions, budgets and cancellation (2.1)
 *
 * Before 2.1 `url()` resolved as soon as the entry node's synchronous prefix
 * had run; nothing said when the asynchronous work downstream was finished,
 * nothing could stop it, and nothing bounded it.  An {@link Execution} now
 * follows every promise the scheduler starts on behalf of one `url()` call
 * (set functions, connector deliveries, loader fetches) and emits `end` only
 * when the last of them has settled, or when the budget runs out, or when the
 * caller cancels.
 */

/** What one execution may consume.  Zero or undefined means "no limit" for that dimension. */
export interface BudgetSpec {
    /** Wall clock time from `begin` to `end`, in milliseconds. */
    wallMs?: number;
    /** Edge traversals (every delivery into a node's edge counts one hop). */
    hops?: number;
    /** Connectors one edge assignment may deliver to. */
    fanOut?: number;
    /** Nesting depth of deliveries (a cycle grows this on every turn). */
    depth?: number;
    /** `host.emit` observations. */
    observations?: number;
    /** How long a cancellation waits for in-flight promises before giving up on them. */
    graceMs?: number;
}

export interface BudgetUsed {
    wallMs: number;
    hops: number;
    fanOut: number;
    depth: number;
    observations: number;
}

export interface BudgetView {
    spec: BudgetSpec;
    used: BudgetUsed;
    /** The dimension that ran out, when one did. */
    exceeded?: string;
}

export type ExecutionState = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "abandoned";

/** The caller's handle on one `url()` invocation. */
export interface ExecutionHandle {
    executionId: string;
    url: string;
    revisionId?: string;
    parentExecutionId?: string;
    state: ExecutionState;
    /** Ask the execution to stop between hops; resolves when it has ended. */
    cancel(reason?: string): Promise<void>;
    /** Settles when the execution has ended, however it ended.  Never rejects. */
    done: Promise<ExecutionResult>;
    budget: BudgetView;
}

export const DEFAULT_BUDGET: BudgetSpec = {
    wallMs: 0,
    hops: 100000,
    fanOut: 10000,
    depth: 512,
    observations: 100000,
    graceMs: 250,
};

/** Where in the execution a piece of work runs: one span per edge traversal. */
export interface Span {
    execution: Execution;
    spanId: string;
    parentSpanId?: string;
    depth: number;
}

export class Execution implements ExecutionHandle {
    executionId: string;
    url: string;
    revisionId?: string;
    parentExecutionId?: string;
    state: ExecutionState;
    budget: BudgetView;
    done: Promise<ExecutionResult>;
    token: CancellationToken;
    /** Set when the entry edge itself failed (as opposed to something downstream). */
    rootFailed: boolean;
    errors: number;
    spans: number;
    startedAt: number;
    endedAt: number;
    reason: string;
    private scheduler: Scheduler;
    private pending: number;
    private armed: boolean;
    private settled: boolean;
    private resolveDone: (result: ExecutionResult) => void;
    private wallTimer: any;
    private graceTimer: any;

    constructor(scheduler: Scheduler, options: { url: string; budget?: BudgetSpec; executionId?: string; revisionId?: string; parentExecutionId?: string }) {
        this.scheduler = scheduler;
        this.executionId = options.executionId || newId();
        this.url = options.url;
        this.revisionId = options.revisionId;
        this.parentExecutionId = options.parentExecutionId;
        this.state = "queued";
        this.budget = {
            spec: {...DEFAULT_BUDGET, ...(options.budget || {})},
            used: {wallMs: 0, hops: 0, fanOut: 0, depth: 0, observations: 0},
        };
        this.token = new CancellationToken();
        this.rootFailed = false;
        this.errors = 0;
        this.spans = 0;
        this.startedAt = 0;
        this.endedAt = 0;
        this.reason = "";
        this.pending = 0;
        this.armed = false;
        this.settled = false;
        this.resolveDone = () => { return; };
        this.done = new Promise<ExecutionResult>((resolve) => { this.resolveDone = resolve; });
    }

    /** Begin the clock and the wall budget. */
    start(): void {
        this.state = "running";
        this.startedAt = Date.now();
        const wallMs = this.budget.spec.wallMs || 0;
        if (wallMs > 0) {
            this.wallTimer = setTimeout(() => {
                this.exceed("wallMs", Date.now() - this.startedAt, wallMs);
            }, wallMs);
            if (this.wallTimer && typeof this.wallTimer.unref === "function") {
                this.wallTimer.unref();
            }
        }
    }

    /** Follow a promise: the execution cannot end while it is pending. */
    track<T>(promise: Promise<T>): Promise<T> {
        this.pending += 1;
        const release = () => {
            this.pending -= 1;
            this.maybeComplete();
        };
        promise.then(release, release);
        return promise;
    }

    /** The synchronous part of the invocation is over; end as soon as nothing is pending. */
    arm(): void {
        this.armed = true;
        this.maybeComplete();
    }

    /** A new span for one edge traversal. */
    span(parent?: Span): Span {
        this.spans += 1;
        const depth = parent ? parent.depth + 1 : 0;
        if (depth > this.budget.used.depth) {
            this.budget.used.depth = depth;
        }
        return {execution: this, spanId: newId(), parentSpanId: parent ? parent.spanId : undefined, depth};
    }

    /** Count a hop and a depth against the budget.  Returns false when the budget is spent. */
    hop(span: Span): boolean {
        this.budget.used.hops += 1;
        const spec = this.budget.spec;
        if (spec.hops && this.budget.used.hops > spec.hops) {
            this.exceed("hops", this.budget.used.hops, spec.hops);
            return false;
        }
        if (spec.depth && span.depth > spec.depth) {
            this.exceed("depth", span.depth, spec.depth);
            return false;
        }
        return true;
    }

    /** Check a fan-out against the budget. */
    fanOut(count: number): boolean {
        if (count > this.budget.used.fanOut) {
            this.budget.used.fanOut = count;
        }
        const limit = this.budget.spec.fanOut;
        if (limit && count > limit) {
            this.exceed("fanOut", count, limit);
            return false;
        }
        return true;
    }

    /** Count an observation against the budget. */
    observe(): boolean {
        this.budget.used.observations += 1;
        const limit = this.budget.spec.observations;
        if (limit && this.budget.used.observations > limit) {
            this.exceed("observations", this.budget.used.observations, limit);
            return false;
        }
        return true;
    }

    /** A budget dimension ran out: report it once and stop the execution. */
    exceed(dimension: string, used: number, limit: number): void {
        if (this.budget.exceeded || this.settled) {
            return;
        }
        this.budget.exceeded = dimension;
        this.errors += 1;
        const err = new Error(`Budget exceeded: ${dimension} used ${used}, limit ${limit}`);
        err.name = "BudgetExceeded";
        this.scheduler.dispatchEvent("error", {
            id: newId(),
            time: Date.now(),
            err,
            message: err.toString(),
            code: "BUDGET_EXCEEDED",
            dimension,
            used,
            limit,
            executionId: this.executionId,
        } as SchedulerEvent);
        this.cancel("budget:" + dimension);
    }

    cancel(reason: string = "cancelled"): Promise<void> {
        if (!this.settled) {
            this.token.cancel(reason);
            this.reason = reason;
            if (this.state === "running" || this.state === "queued") {
                this.state = "cancelling";
                this.scheduler.dispatchEvent("cancel", {
                    id: newId(),
                    time: Date.now(),
                    executionId: this.executionId,
                    reason,
                } as SchedulerEvent);
            }
            // in-flight promises that never settle would keep the execution open forever
            const graceMs = this.budget.spec.graceMs === undefined ? 250 : this.budget.spec.graceMs;
            this.graceTimer = setTimeout(() => {
                if (!this.settled) {
                    this.settle("abandoned", reason + " (pending promises abandoned)");
                }
            }, graceMs);
            if (this.graceTimer && typeof this.graceTimer.unref === "function") {
                this.graceTimer.unref();
            }
            this.maybeComplete();
        }
        return this.done.then(() => { return; });
    }

    private maybeComplete(): void {
        if (this.settled || !this.armed || this.pending > 0) {
            return;
        }
        if (this.token.cancelled) {
            this.settle("cancelled", this.reason);
        } else if (this.rootFailed) {
            this.settle("failed", "entry node failed");
        } else {
            this.settle("completed", "");
        }
    }

    private settle(state: ExecutionState, reason: string): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.state = state;
        this.reason = reason;
        this.endedAt = Date.now();
        this.budget.used.wallMs = this.endedAt - this.startedAt;
        if (this.wallTimer) {
            clearTimeout(this.wallTimer);
        }
        if (this.graceTimer) {
            clearTimeout(this.graceTimer);
        }
        this.scheduler.forget(this);
        const result: ExecutionResult = {
            nodes: [],
            executionId: this.executionId,
            url: this.url,
            state,
            reason: reason || undefined,
            duration: this.budget.used.wallMs,
            hops: this.budget.used.hops,
            spans: this.spans,
            errors: this.errors,
            budget: this.budget,
        };
        this.scheduler.dispatchEvent("end", {
            url: this.url,
            time: this.endedAt,
            id: newId(),
            duration: this.budget.used.wallMs,
            executionId: this.executionId,
            state,
            reason: reason || undefined,
            hops: this.budget.used.hops,
            errors: this.errors,
        } as SchedulerEvent);
        this.resolveDone(result);
    }

    get isSettled(): boolean {
        return this.settled;
    }
}
