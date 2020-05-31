import Edge, {execute as edgeExecute} from "./Edge";
import {parseScript} from 'meriyah';
import {generate} from "escodegen";
import Scheduler from "./Scheduler";
import {ConnectorEvent, Graph, newId, EdgeError, VectorTemplate,
    LinkedVector, LinkedGraph, VectorInterface, VectorSetEvent} from "./Shared";
/**
*
* Vectors are the building blocks of the graph.
* Vectors represent a unit of code.
* Units of code in Plastic-IO are _domain agnostic_.
* That means the code in your vectors can execute in many different domains.
* For example, your vector can be called upon to work in a browser environment
* or in the server environment.

* Your vector addtionally can be called upon to supply a user interface to
* simply display data, or to provide a complex control panel.
*
* Your vector also contains tests, and is segmented from the graph in such a way
* that it can be imported to other graphs where users can reuse to the
* units of code that you create.
*
* This is made version safe through [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) patterns.
* Vecotrs, as well as {@link Graph}s are made to be shared.
*
* Although it's not difficult to construct Plastic-IO graphs by hand.
* You can also use the [Plastic-IO Graph Editor](https://github.com/plastic-io/graph-editor).
*
*/
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
    /**
     * Ephemeral value that should not be commited to a data store.
     * Used to store domain specific instance idenfitifer.
     */
    __contextId: any;
}
/** Utility to parse and run vectors.  Used internally to run the vector's set function.*/
async function parseAndRun(code: string, vectorInterface: VectorInterface): Promise<any> {
    const ast = parseScript(code, {
        loc: true,
        module: true,
        next: true,
        globalReturn: true,
    });
    // tslint:disable-next-line
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor; // eslint-disable-line 
    const vectorFn = new AsyncFunction("scheduler", "graph", "cache", "vector", "field",
        "state", "value", "edges", "data", "properties", "require", generate(ast));
    vectorInterface.scheduler.dispatchEvent("set", {
        id: newId(),
        vectorId: vectorInterface.vector.id,
        graphId: vectorInterface.vector.graphId,
        field: vectorInterface.field,
        time: Date.now(),
        vectorInterface,
        setContext(val: any) {
            vectorInterface.scheduler.logger.debug(`Vector: setContext setting context of vector.`);
            vectorInterface.context = val;
        },
    } as VectorSetEvent);
    return await vectorFn.call(
        vectorInterface.context,
        vectorInterface.scheduler,
        vectorInterface.graph,
        vectorInterface.cache,
        vectorInterface.vector,
        vectorInterface.field,
        vectorInterface.state,
        vectorInterface.value,
        vectorInterface.edges,
        vectorInterface.data,
        vectorInterface.properties,
        (path: any) => {
            return eval("require")(path); // tslint:disable-line
        },
    );
}
/** Utility to connect linked vectors and the host graph's vector.  Used internally.*/
export function getLinkedInputs(vect: Vector, field: string, scheduler: Scheduler): any {
    const log = scheduler.logger;
    const graph = vect.linkedGraph!.graph;// eslint-disable-line
    const outputs = vect.linkedGraph!.fields.outputs;// eslint-disable-line
    const inputs = vect.linkedGraph!.fields.inputs;// eslint-disable-line
    // ----- INPUTS
    // linked graph inputs (this part was easy)
    // replace field with internally mapped field
    log.debug(`Vector: edge map inputs: ${Object.keys(inputs).join()}`);
    const mappedConnector = inputs[field];
    if (mappedConnector) {
        field = mappedConnector.field;
        // map to the internal vector using the fieldMap
        vect = graph.vectors.find((v: Vector) => {
            return v.id === mappedConnector.id;
        }) as Vector;
        log.debug("Vector: mapped vector.id " + vect.id);
    }
    return {
        field,
        vector: vect,
    };
}
/** Utility to connect linked vectors and the host graph's vector.  Used internally.*/
export function linkInnerVectorEdges(vect: Vector, scheduler: Scheduler): void {
    const log = scheduler.logger;
    const graph = vect.linkedGraph!.graph;// eslint-disable-line
    const outputs = vect.linkedGraph!.fields.outputs;// eslint-disable-line
    const inputs = vect.linkedGraph!.fields.inputs;// eslint-disable-line
    if (!graph) {
        throw new Error("Critical Error: Linked graph not found on vector.id: " + vect.id);
    }
    // ----- OUTPUTS
    // linked graph outputs (this part was hard)
    // connect output on this graph JIT using the field map
    log.debug(`Vector: Linked graph: Attach output connectors from map. Embedded graph vector count: ${graph.vectors.length}, vector.id ${vect.id}`);
    graph.vectors.forEach((v: Vector) => {
        if (vect.linkedGraph && Object.prototype.hasOwnProperty.call(vect.linkedGraph.data, v.id)) {
            log.debug(`Vector: Linked graph set linked data.  Data type ${typeof vect.linkedGraph.data[v.id]}`);
            v.data = vect.linkedGraph.data[v.id];
        }
        v.properties = (vect.linkedGraph && Object.prototype.hasOwnProperty.call(vect.linkedGraph.properties, v.id)) ? vect.linkedGraph.properties[v.id] : v.properties;
        v.edges.forEach((edg: Edge) => {
            log.debug(`Vector: edge map outputs: ${Object.keys(outputs).join()}`);
            Object.keys(outputs).forEach((outputField) => { // eslint-disable-line
                const output = vect.linkedGraph!.fields.outputs[outputField]; // eslint-disable-line
                const linkedEdge = vect.edges.find((edge) => {
                    return edge.field === output.field && output.id === v.id;
                });
                if (!linkedEdge) {
                    log.debug(`Vector: No linked edges found for field: ${output.field} id: ${output.id}`);
                    return;
                }
                log.debug(`%cVector: Linked edges found for field: ${output.field} id: ${output.id} connectors ${linkedEdge.connectors.length}`
                    , "background: green; color: white; font-weight: bold;");
                const connectorIds = edg.connectors.map(c => c.id);
                linkedEdge.connectors.forEach((c) => {
                    if (connectorIds.indexOf(c.id) === -1) {
                        edg.connectors.push(c);
                    }
                });
            });
        });
    });
}
/** Run connector code in isolation, creates interface.  Used internally. */
export async function execute(scheduler: Scheduler, graph: Graph, vector: Vector, field: string, value: any): Promise<any> {
    const log = scheduler.logger;
    log.debug(`Vector: Begin execute vector.id ${vector.id}, field ${field}`);
    let vect = vector;
    if (vector.linkedVector && !vector.linkedVector.loaded) {
        log.debug(`Vector: Load linkedVector.id ${vector.linkedVector.id} for vector.id: ${vector.id}`);
        vector.linkedVector.vector = await scheduler.vectorLoader.load(scheduler.getVectorPath(vector.linkedVector.id, vector.linkedVector.version));
        if (!vector.linkedVector.vector) {
            const err = new Error(`Vector: Critical Error: Linked vector not found on vector.id: ${vector.id}`);
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
    if (vect.linkedGraph) {
        if (!vect.linkedGraph.loaded) {
            log.debug(`Vector: Load linked graph for vector.id ${vector.id}`);
            vect.linkedGraph.graph = await scheduler.graphLoader.load(scheduler.getGraphPath(vect.linkedGraph.id, vect.linkedGraph.version));
            linkInnerVectorEdges(vect, scheduler);
            vect.linkedGraph.loaded = true;
        }
        if (vector.linkedGraph && !vector.linkedGraph.graph) {
            const err = new Error(`Vector: Critical Error: Linked graph not found on vector.id: ${vector.id}`);
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
            graph = vect.linkedGraph!.graph;// eslint-disable-line
            const proxyInput = getLinkedInputs(vect, field, scheduler);
            field = proxyInput.field;
            vect = proxyInput.vector;
        }
    }
    const edges = {};
    // create outputs for interface
    log.debug(`Vector: vector.edge.length ${vect.edges.length}`);
    vect.edges.forEach((edge: Edge) => {
        Object.defineProperty(edges, edge.field, {
            set: async (setterVal: any) => {
                async function setter(val: any): Promise<void> {
                    log.debug(`Vector: Edge setter invoked. field ${edge.field}, edge.connectors.length ${edge.connectors.length}, vector.id ${vect.id}, graph.id, ${graph.id}`);
                    for (const connector of edge.connectors) {
                        if (connector.graphId !== graph.id || connector.version !== graph.version) {
                            graph = await scheduler.graphLoader.load(scheduler.getGraphPath(connector.graphId, connector.version));
                        }
                        const vectorNext = graph.vectors.find((v: Vector) => {
                            return connector.vectorId === v.id;
                        });
                        if (vectorNext) {
                            log.debug(`Vector: Edge.execute vectorNext.id ${vectorNext.id} vectorNext.graphId ${vectorNext.graphId}`);
                            const start = Date.now();
                            scheduler.dispatchEvent("beginconnector", {
                                time: start,
                                id: newId(),
                                connector,
                                value: val,
                            } as ConnectorEvent);
                            await edgeExecute(scheduler, graph, vectorNext, connector.field, val);
                            const end = Date.now();
                            scheduler.dispatchEvent("endconnector", {
                                time: end,
                                duration: end - start,
                                id: newId(),
                                connector,
                                value: val,
                            } as ConnectorEvent);
                        } else {
                            const err = new Error(`Connector refers to a vector edge that does not exist.  Connector.id: ${connector.id}`);
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
                    const er = new Error(`Vector: Edge setter error. field ${edge.field}, vector.id ${vect.id}. Error: ${err}`);
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
        scheduler,
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
        log.debug(`Vector: Parse and run template for vector.id: ${vector.id} template length ${vect.template.set.length}`);
        try {
            setResult = await parseAndRun(vect.template.set, vectorInterface);
        } catch (err) {
            er = err;
            scheduler.logger.error(`Vector: set function caused an error: ${err.stack}`);
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
        scheduler.dispatchEvent("afterSet", {
            id: newId(),
            err: er,
            return: setResult,
            time: Date.now(),
            vectorInterface,
        } as VectorSetEvent);
    } else if (!vect.linkedGraph) {
        const err = new Error(`Vector: No template for set found on vector.id ${vector.id}`);
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
