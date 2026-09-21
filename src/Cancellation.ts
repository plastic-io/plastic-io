/**
 * Cooperative cancellation for executions (2.1).  Nothing here can stop
 * JavaScript that is already running; the token is checked between hops and
 * before every delivery, and handed to host calls as an AbortSignal.
 */
import {ExecutionCancelled} from "./ExecutionCancelled";
export {ExecutionCancelled};

/** Cooperative stop signal, checked at every hop and available to host calls. */
export class CancellationToken {
    cancelled: boolean;
    reason: string;
    private controller: any;
    constructor() {
        this.cancelled = false;
        this.reason = "";
        this.controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    }
    /** An AbortSignal for host calls such as fetch, when the platform has one. */
    get signal(): any {
        return this.controller ? this.controller.signal : undefined;
    }
    cancel(reason: string): void {
        if (this.cancelled) {
            return;
        }
        this.cancelled = true;
        this.reason = reason;
        if (this.controller) {
            try { this.controller.abort(); } catch (err) { /* older platforms */ }
        }
    }
    throwIfCancelled(): void {
        if (this.cancelled) {
            throw new ExecutionCancelled(this.reason);
        }
    }
}

