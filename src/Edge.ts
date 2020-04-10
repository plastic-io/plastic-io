import Vector, {execute as vectorExecute} from "./Vector";
import {Graph, SchedulerEvent, newId, EdgeError, Connector} from "./Shared";
import Scheduler from "./Scheduler";
/** The edge of a vector, what connectors connect to. */
export default interface Edge {
    /** Name of the edge */
    field: string;
    /** Connectors that connect the edges together */
    connectors: Connector[];
}
/** Executes a given edge.  Edges are always inputs (LTR) */
export async function execute(scheduler: Scheduler, graph: Graph,
        vector: Vector, field: string, value: any, currentVector: Vector | null, linkedEdges?: any[]): Promise<any> {
    const currentVectorId = currentVector ? currentVector.id : null;
    const start = Date.now();
    scheduler.dispatchEvent("beginedge", {
        time: start,
        id: newId(),
        linkedEdges: linkedEdges || [],
        vectorId: vector.id,
        graphId: graph.id,
        currentVectorId,
        field,
        value,
    } as SchedulerEvent);
    scheduler.logger.debug("Edge: Vector.execute: vector.id:field " + vector.id + ":" + field);
    function end(): void {
        const now = Date.now();
        scheduler.dispatchEvent("endedge", {
            time: now,
            id: newId(),
            duration: now - start,
            linkedEdges: linkedEdges || [],
            vectorId: vector.id,
            graphId: graph.id,
            currentVectorId,
            field,
            value,
        } as SchedulerEvent);
    }
    vectorExecute(scheduler, graph, vector, field, value)
    .then(end)
    .catch((err) => {
        const er = new Error("Edge: Error occured during vector.execute: " + err.stack);
        scheduler.logger.error(er.stack);
        scheduler.dispatchEvent("error", {
            id: newId(),
            time: Date.now(),
            err: er,
            message: er.toString(),
            linkedEdges: linkedEdges || [],
            vectorId: vector.id,
            currentVectorId,
            graphId: graph.id,
            field,
            value,
        } as EdgeError);
        end();
    });
}
