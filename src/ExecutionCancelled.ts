/** Thrown into node code and connector chains once an execution is cancelled. */
export class ExecutionCancelled extends Error {
    reason: string;
    constructor(reason: string) {
        super("Execution cancelled: " + reason);
        this.name = "ExecutionCancelled";
        this.reason = reason;
        Object.setPrototypeOf(this, ExecutionCancelled.prototype);
    }
}

