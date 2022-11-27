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
export async function execute(scheduler: Scheduler, graph: Graph, node: Node, field: string, value: any): Promise<any> {
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
    function end(): void {
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
    }
    await nodeExecute(scheduler, graph, node, field, value)
    .then(end)
    .catch((err) => {
        const er = new Error("Edge: Error occured during node.execute: " + err.stack);
        scheduler.logger.error(er.stack);
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
        end();
    });
}
