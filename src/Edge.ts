import Node, {execute as nodeExecute} from "./Node";
import {Graph, SchedulerEvent, newId, EdgeError, Connector, EventIds} from "./Shared";
import Scheduler from "./Scheduler";
import {Span, ExecutionCancelled} from "./Execution";

/** The edge of a node, what connectors connect to. */
export default interface Edge {
    /** Name of the edge */
    field: string;
    /** Connectors that connect the edges together */
    connectors: Connector[];
}

/**
 * Executes a given edge.  Edges are always inputs (LTR).
 *
 * One call is one hop of the execution: it is counted against the budget,
 * refused once the execution is cancelled, and carries its own span id so
 * the events it produces can be tied together (2.1).
 */
export function execute(scheduler: Scheduler, graph: Graph, node: Node, field: string, value: any, span?: Span): Promise<void> {
    return new Promise(async (resolve, reject) => {
        const start = Date.now();
        const execution = span ? span.execution : undefined;
        const ids: EventIds = span ? {executionId: span.execution.executionId, spanId: span.spanId, parentSpanId: span.parentSpanId} : {};
        if (execution) {
            if (execution.token.cancelled) {
                return reject(new ExecutionCancelled(execution.token.reason));
            }
            if (!execution.hop(span as Span)) {
                return reject(new ExecutionCancelled(execution.token.reason));
            }
        }
        scheduler.dispatchEvent("beginedge", {
            time: start,
            id: newId(),
            nodeId: node.id,
            graphId: graph.id,
            field,
            value,
            ...ids,
        } as SchedulerEvent);

        scheduler.logger.debug("Edge: Node.execute: node.id:field " + node.id + ":" + field);

        function end(er: any): void {
            if (er) {
                reject(er);  // Reject the promise here
            }
            const now = Date.now();
            scheduler.dispatchEvent("endedge", {
                time: now,
                id: newId(),
                duration: now - start,
                nodeId: node.id,
                graphId: graph.id,
                field,
                value,
                ...ids,
            } as SchedulerEvent);
            resolve();  // Resolve the promise here
        }

        nodeExecute(scheduler, graph, node, field, value, span).then(() => {
            end(null);
        }).catch((err: any) => {
            if (execution) {
                execution.errors += 1;
            }
            const er = new Error("Edge: Error occurred during node.execute: " + err);
            scheduler.logger.error(er);
            scheduler.dispatchEvent("error", {
                id: newId(),
                time: Date.now(),
                err: er,
                message: er.toString(),
                nodeId: node.id,
                graphId: graph.id,
                field,
                value,
                ...ids,
            } as EdgeError);
            end(err);
        });

    });
}
