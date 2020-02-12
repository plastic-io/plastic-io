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
export async function execute(scheduler: Scheduler, graph: Graph, vector: Vector, field: string, value: any): Promise<any> {
    scheduler.dispatchEvent("beginedge", {
        time: Date.now(),
        id: newId(),
    } as SchedulerEvent);
    const start = Date.now();
    scheduler.logger.debug("Edge: Vector.execute: vector.id:field " + vector.id + ":" + field);
    function end(): void {
        scheduler.dispatchEvent("endedge", {
            time: Date.now(),
            id: newId(),
            duration: Date.now() - start,
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
        } as EdgeError);
        end();
    });
}
