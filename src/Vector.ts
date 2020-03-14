import Edge, {execute as edgeExecute} from "./Edge";
import {parseScript} from 'meriyah';
import {generate} from "escodegen";
import Scheduler from "./Scheduler";
import {Graph, newId, EdgeError, VectorTemplate, LinkedVector, LinkedGraph, VectorInterface, VectorSetEvent} from "./Shared";
export default interface Vector {
    /** The unique UUID of this vector */
    id: string;
    linkedGraph?: LinkedGraph;
    linkedVector?: LinkedVector;
    /** Output edges on the vector */
    edges: Edge[];
    /** Used along with graphId to locate vectors in linked resources */
    version: number;
    /** Used along with version to locate vectors in linked resources */
    graphId: string;
    /** The URL to this vector, combined with the vector's graphId */
    url: string;
    /**
     * This property holds domain specific non-volitalie data associated
     * with this vector instance
     */
    data: any; // eslint-disable-line
    /**
     * This property contains non-volitalie meta information about the vector,
     * such as placement in the UI, executable code, and other meta properties
     * specific to the domain of the vector
     */
    properties: any;
    /** Vector template.  Defines UX and runtime code. */
    template: VectorTemplate;
}
async function parseAndRun(code: string, vectorInterface: VectorInterface): Promise<any> {
    const ast = parseScript(code, {
        loc: true,
        module: true,
        next: true,
        globalReturn: true,
    });
    const vectorFn = new Function("graph", "cache", "vector", "field",
        "state", "value", "edges", "data", "properties", generate(ast));
    return await vectorFn(
        vectorInterface.graph,
        vectorInterface.cache,
        vectorInterface.vector,
        vectorInterface.field,
        vectorInterface.state,
        vectorInterface.value,
        vectorInterface.edges,
        vectorInterface.data,
        vectorInterface.properties,
    );
}
/** Run connector code in isolation, create interface */
export async function execute(scheduler: Scheduler, graph: Graph, vector: Vector, field: string, value: any): Promise<any> {
    const log = scheduler.logger;
    log.debug("Vector: Begin execute vector.id " + vector.id + ", field " + field);
    // load linked resources JIT
    let vect = vector;
    if (vector.linkedVector && !vector.linkedVector.loaded) {
        log.debug("Vector: Load linked vector " + vector.linkedVector.id + " for vector.id: " + vector.id);
        vector.linkedVector.vector = await scheduler.vectorLoader.load(scheduler.getVectorPath(vector.linkedVector.id, vector.linkedVector.version));
        if (!vector.linkedVector.vector) {
            const err = new Error("Vector: Critical Error: Linked vector not found on vector.id: " + vector.id);
            log.error(err.stack);
            scheduler.dispatchEvent("error", {
                id: newId(),
                time: Date.now(),
                err,
                message: err.toString(),
                vectorId: vector.id,
                graphId: graph.id,
            } as EdgeError);
        } else {
            vector.linkedVector.loaded = true;
            // use the linked vector from here on out
            vect = vector.linkedVector.vector;
            vect.data = vector.data;
            vect.properties = vector.properties;
        }
    }
    if (vect.linkedGraph && !vect.linkedGraph.loaded) {
        log.debug("Vector: Load linked graph for vector.id " + vector.id);
        vect.linkedGraph.graph = await scheduler.graphLoader.load(scheduler.getGraphPath(vect.linkedGraph.id, vect.linkedGraph.version));
        if (vector.linkedGraph && !vector.linkedGraph.graph) {
            const err = new Error("Vector: Critical Error: Linked graph not found on vector.id: " + vector.id);
            log.error(err.stack);
            scheduler.dispatchEvent("error", {
                id: newId(),
                time: Date.now(),
                err,
                message: err.toString(),
                vectorId: vector.id,
                graphId: graph.id,
            } as EdgeError);
        } else {
            vect.linkedGraph.loaded = true;
            // use the linked graph for vectorNext search
            graph = vect.linkedGraph.graph;
            // ----- OUTPUTS
            // linked graph outputs (this part was hard)
            // connect output on this graph JIT using the field map
            log.debug("Vector: Linked graph: Attach output connectors from map. Embedded graph vector count: " + graph.vectors.length);
            graph.vectors.forEach((v: Vector) => {
                log.debug("Vector: Linked graph set linked data");
                v.data = (vect.linkedGraph && Object.prototype.hasOwnProperty.call(vect.linkedGraph.data, v.id)) ? vect.linkedGraph.data[v.id] : v.data;
                v.properties = (vect.linkedGraph && Object.prototype.hasOwnProperty.call(vect.linkedGraph.properties, v.id)) ? vect.linkedGraph.properties[v.id] : v.properties;
                v.edges.forEach((edg: Edge) => {
                    log.debug("Vector: edge map outputs: ", vect.linkedGraph!.fields.outputs); // eslint-disable-line
                    Object.keys(vect.linkedGraph!.fields.outputs).forEach((outputField) => { // eslint-disable-line
                        const output = vect.linkedGraph!.fields.outputs[outputField]; // eslint-disable-line
                        const linkedEdge = vect.edges.find((edge) => {
                            return edge.field === output.field && output.id === v.id;
                        });
                        if (!linkedEdge) {
                            return;
                        }
                        log.debug("Vector: linkedEdge.connectors count " + linkedEdge.connectors.length);
                        // replace inner graph outputs with host vector
                        edg.connectors = edg.connectors = [
                            ...edg.connectors,
                            ...linkedEdge.connectors,
                        ];
                        log.debug("Vector: Linked graph output mapped.  edge.id " + edg
                            + ".  Proxied output count " + edg.connectors.length);
                    });
                });
            });
            // ----- INPUTS
            // linked graph inputs (this part was easy)
            // replace field with internally mapped field
            log.debug("Vector: edge map inputs: ", vect.linkedGraph.fields.outputs);
            const mappedConnector = vect.linkedGraph.fields.inputs[field];
            field = mappedConnector.field;
            // map to the internal vector using the fieldMap
            vect = graph.vectors.find((v: Vector) => {
                return v.id === mappedConnector.id;
            }) as Vector;
            log.debug("Vector: mapped vector.id " + vect.id);
        }
    }
    const edges = {};
    // create outputs for interface
    log.debug("Vector: vector.edge.length " + vect.edges.length);
    vect.edges.forEach((edge: Edge) => {
        Object.defineProperty(edges, edge.field, {
            set: async (setterVal: any) => {
                async function setter(val: any): Promise<void> {
                    log.debug("Vector: Edge setter invoked. field " + edge.field + ", vector.id " + vect.id);
                    for (const connector of edge.connectors) {
                        if (connector.graphId !== graph.id || connector.version !== graph.version) {
                            graph = await scheduler.graphLoader.load(scheduler.getGraphPath(connector.graphId, connector.version));
                        }
                        const vectorNext = graph.vectors.find((v: Vector) => {
                            return connector.vectorId === v.id;
                        });
                        if (vectorNext) {
                            log.debug("Vector: Edge.execute vectorNext.id " + vectorNext.id + " vectorNext.graphId " + vectorNext.graphId);
                            await edgeExecute(scheduler, graph, vectorNext, connector.field, val);
                        } else {
                            const err = new Error("Connector refers to a vector edge that does not exist.  Connector.id: " + connector.id);
                            log.error(err.stack);
                            scheduler.dispatchEvent("error", {
                                id: newId(),
                                time: Date.now(),
                                err,
                                message: err.toString(),
                                edgeField: edge.field,
                                connectorId: connector.id,
                                vectorId: vect.id,
                                graphId: graph.id,
                            } as EdgeError);
                        }
                    }
                }
                try {
                    await setter(setterVal);
                } catch(err) {
                    const er = new Error("Vector: Edge setter error. field " + edge.field + ", vector.id " + vect.id + ": " + err);
                    log.error(er.stack);
                    scheduler.dispatchEvent("error", {
                        id: newId(),
                        time: Date.now(),
                        err: er,
                        message: er.toString(),
                        edgeField: edge.field,
                        vectorId: vect.id,
                        graphId: graph.id,
                    } as EdgeError);
                }
            }
        });
    });
    // ensure the vector has a cache for private use
    scheduler.vectorCache[vect.id] = scheduler.vectorCache[vect.id] || {};
    // provide interface for invoking code
    const vectorInterface = {
        edges,
        state: scheduler.state,
        field,
        value,
        vector: vect,
        cache: scheduler.vectorCache[vect.id],
        graph,
        data: vect.data,
        properties: vect.properties,
    } as VectorInterface;
    if (vect.template.set) {
        let er;
        let setResult: any;
        log.debug("Vector: Parse and run template for vector.id: " + vector.id + " template length " + vect.template.set.length);
        try {
            setResult = await parseAndRun(vect.template.set, vectorInterface);
        } catch (err) {
            er = err;
            scheduler.logger.error("Vector: set function caused an error: " + err.stack);
            scheduler.dispatchEvent("error", {
                id: newId(),
                time: Date.now(),
                err,
                message: err.toString(),
                vectorId: vect.id,
                graphId: graph.id,
                field,
            } as EdgeError);
        }
        scheduler.dispatchEvent("set", {
            id: newId(),
            err: er,
            return: setResult,
            time: Date.now(),
            vectorInterface,
        } as VectorSetEvent);
    } else if (!vect.linkedGraph) {
        const err = new Error("Vector: No template for set found on vector.id " + vector.id);
        scheduler.logger.error(err.stack);
        scheduler.dispatchEvent("error", {
            id: newId(),
            time: Date.now(),
            err,
            message: err.toString(),
            vectorId: vect.id,
            graphId: graph.id,
            field,
        } as EdgeError);
    }
}
