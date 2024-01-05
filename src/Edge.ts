import Node, {execute as nodeExecute} from "./Node";
import {Graph, SchedulerEvent, newId, EdgeError, Connector} from "./Shared";
import Scheduler from "./Scheduler";

/** The edge of a node, what connectors connect to. */
export default interface Edge {
    /** Name of the edge */
    field: string;
    /** Connectors that connect the edges together */
    connectors: Connector[];
}

/** Executes a given edge.  Edges are always inputs (LTR) */
export function execute(scheduler: Scheduler, graph: Graph, node: Node, field: string, value: any): Promise<void> {
    return new Promise(async (resolve, reject) => {
        const start = Date.now();
        scheduler.dispatchEvent("beginedge", {
            time: start,
            id: newId(),
            nodeId: node.id,
            graphId: graph.id,
            field,
            value,
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
            } as SchedulerEvent);
            resolve();  // Resolve the promise here
        }

        nodeExecute(scheduler, graph, node, field, value).then(() => {
            end(null);
        }).catch((err: any) => {
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
            } as EdgeError);
            end(err);
        });

    });
}
