import Edge, {execute as edgeExecute} from "./Edge";
import {parseScript} from 'meriyah';
import {generate} from "escodegen";
import Scheduler from "./Scheduler";
import {ConnectorEvent, Graph, newId, EdgeError, NodeTemplate,
    LinkedNode, LinkedGraph, NodeInterface, NodeSetEvent} from "./Shared";
/**
 *
 * Nodes are the building blocks of the graph.
 * Nodes represent a unit of code.
 * Units of code in Plastic-IO are _domain agnostic_.
 * That means the code in your nodes can execute in many different domains.
 * For example, your node can be called upon to work in a browser environment
 * or in the server environment.
 *
 * Your node addtionally can be called upon to supply a user interface to
 * simply display data, or to provide a complex control panel.
 *
 * Your node also contains tests, and is segmented from the graph in such a way
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
export default interface Node {
    /** The unique UUID of this node */
    id: string;
    linkedGraph?: LinkedGraph;
    linkedNode?: LinkedNode;
    /** Output edges on the node */
    edges: Edge[];
    /** Used along with graphId to locate nodes in linked resources */
    version: number;
    /** Used along with version to locate nodes in linked resources */
    graphId: string;
    /** The URL to this node, combined with the node's graphId */
    url: string;
    /**
     * This property holds domain specific non-volitalie data associated
     * with this node instance
     */
    data: any; // eslint-disable-line
    /**
     * This property contains non-volitalie meta information about the node,
     * such as placement in the UI, executable code, and other meta properties
     * specific to the domain of the node
     */
    properties: any;
    /** Node template.  Defines UX and runtime code. */
    template: NodeTemplate;
    /**
     * Ephemeral value that should not be commited to a data store.
     * Used to store domain specific instance idenfitifer.
     */
    __contextId: any;
}
/** Utility to parse and run nodes.  Used internally to run the node's set function. */
function parseAndRun(code: string, nodeInterface: NodeInterface): Promise<any> {
    return new Promise(async (resolve, reject) => {
        try {
            const ast = parseScript(code, {
                loc: true,
                module: true,
                next: true,
                globalReturn: true,
            });

            // tslint:disable-next-line
            const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor; // eslint-disable-line 
            const nodeFn = new AsyncFunction("scheduler", "graph", "cache", "node", "field",
                "state", "value", "edges", "data", "properties", "require", generate(ast));
            nodeInterface.scheduler.dispatchEvent("set", {
                id: newId(),
                nodeId: nodeInterface.node.id,
                graphId: nodeInterface.node.graphId,
                field: nodeInterface.field,
                time: Date.now(),
                nodeInterface,
                setContext(val: any) {
                    nodeInterface.scheduler.logger.debug(`Node: setContext setting context of node.`);
                    nodeInterface.context = val;
                },
            } as NodeSetEvent);
            nodeInterface.scheduler.logger.debug(`Node: about to execute compiled function.`);
            Promise.resolve(nodeFn.call(
                nodeInterface.context,
                nodeInterface.scheduler,
                nodeInterface.graph,
                nodeInterface.cache,
                nodeInterface.node,
                nodeInterface.field,
                nodeInterface.state,
                nodeInterface.value,
                nodeInterface.edges,
                nodeInterface.data,
                nodeInterface.properties,
                (path: any) => {
                    return eval("require")(path); // tslint:disable-line
                },
            ))
            .then(result => {
                nodeInterface.scheduler.logger.debug(`Node: just executed compiled function without error.`);
                resolve(result);
            })
            .catch(error => {
                nodeInterface.scheduler.logger.debug(`Node: just executed compiled function with error ${error}.`);
                reject(error);
            });
        } catch (error) {
            nodeInterface.scheduler.logger.debug(`Node: caught an error while script parsing: ${error}.`);
            reject(error);
        }
    });
}
/** Utility to connect linked nodes and the host graph's node.  Used internally. */
export function getLinkedInputs(vect: Node, field: string, scheduler: Scheduler): any {
    const log = scheduler.logger;
    const graph = vect.linkedGraph!.graph;// eslint-disable-line
    const outputs = vect.linkedGraph!.fields.outputs;// eslint-disable-line
    const inputs = vect.linkedGraph!.fields.inputs;// eslint-disable-line
    // ----- INPUTS
    // linked graph inputs (this part was easy)
    // replace field with internally mapped field
    log.debug(`Node: edge map inputs: ${Object.keys(inputs).join()}`);
    const mappedConnector = inputs[field];
    if (mappedConnector) {
        field = mappedConnector.field;
        // map to the internal node using the fieldMap
        vect = graph.nodes.find((v: Node) => {
            return v.id === mappedConnector.id;
        }) as Node;
        log.debug("Node: mapped node.id " + vect.id);
    }
    return {
        field,
        node: vect,
    };
}
/** Utility to connect linked nodes and the host graph's node.  Used internally. */
export function linkInnerNodeEdges(vect: Node, scheduler: Scheduler): void {
    const log = scheduler.logger;
    const graph = vect.linkedGraph!.graph;// eslint-disable-line
    const outputs = vect.linkedGraph!.fields.outputs;// eslint-disable-line
    const inputs = vect.linkedGraph!.fields.inputs;// eslint-disable-line
    if (!graph) {
        throw new Error("Critical Error: Linked graph not found on node.id: " + vect.id);
    }
    // ----- OUTPUTS
    // linked graph outputs (this part was hard)
    // connect output on this graph JIT using the field map
    log.debug(`Node: Linked graph: Attach output connectors from map. Embedded graph node count: ${graph.nodes.length}, node.id ${vect.id}`);
    graph.nodes.forEach((v: Node) => {
        if (vect.linkedGraph && Object.prototype.hasOwnProperty.call(vect.linkedGraph.data, v.id)) {
            log.debug(`Node: Linked graph set linked data.  Data type ${typeof vect.linkedGraph.data[v.id]}`);
            v.data = vect.linkedGraph.data[v.id];
        }
        v.properties = (vect.linkedGraph && Object.prototype.hasOwnProperty.call(vect.linkedGraph.properties, v.id)) ? vect.linkedGraph.properties[v.id] : v.properties;
        v.edges.forEach((edg: Edge) => {
            log.debug(`Node: edge map outputs: ${Object.keys(outputs).join()}`);
            Object.keys(outputs).forEach((outputField) => { // eslint-disable-line
                const output = vect.linkedGraph!.fields.outputs[outputField]; // eslint-disable-line
                const linkedEdge = vect.edges.find((edge) => {
                    return edge.field === output.field && output.id === v.id;
                });
                if (!linkedEdge) {
                    log.debug(`Node: No linked edges found for field: ${output.field} id: ${output.id}`);
                    return;
                }
                log.debug(`%cNode: Linked edges found for field: ${output.field} id: ${output.id} connectors ${linkedEdge.connectors.length}`
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
export async function execute(scheduler: Scheduler, graph: Graph, node: Node, field: string, value: any): Promise<any> {
    const log = scheduler.logger;
    log.debug(`Node: Begin execute node.id ${node.id}, field ${field}`);
    let vect = node;
    if (node.linkedNode && !node.linkedNode.loaded) {
        log.debug(`Node: Load linkedNode.id ${node.linkedNode.id} for node.id: ${node.id}`);
        node.linkedNode.node = await scheduler.nodeLoader.load(scheduler.getNodePath(node.linkedNode.id, node.linkedNode.version));
        if (!node.linkedNode.node) {
            const err = new Error(`Node: Critical Error: Linked node not found on node.id: ${node.id}`);
            log.error(err.stack);
            scheduler.dispatchEvent("error", {
                id: newId(),
                time: Date.now(),
                err,
                message: err.toString(),
                nodeId: node.id,
                graphId: graph.id,
            } as EdgeError);
        } else {
            node.linkedNode.loaded = true;
            // use the linked node from here on out
            vect = node.linkedNode.node;
            vect.data = node.data;
            vect.properties = node.properties;
        }
    }
    if (vect.linkedGraph) {
        if (!vect.linkedGraph.loaded) {
            log.debug(`Node: Load linked graph for node.id ${node.id}`);
            vect.linkedGraph.graph = await scheduler.graphLoader.load(scheduler.getGraphPath(vect.linkedGraph.id, vect.linkedGraph.version));
            linkInnerNodeEdges(vect, scheduler);
            vect.linkedGraph.loaded = true;
        }
        if (node.linkedGraph && !node.linkedGraph.graph) {
            const err = new Error(`Node: Critical Error: Linked graph not found on node.id: ${node.id}`);
            log.error(err.stack);
            scheduler.dispatchEvent("error", {
                id: newId(),
                time: Date.now(),
                err,
                message: err.toString(),
                nodeId: node.id,
                graphId: graph.id,
            } as EdgeError);
        } else {
            graph = vect.linkedGraph!.graph;// eslint-disable-line
            const proxyInput = getLinkedInputs(vect, field, scheduler);
            field = proxyInput.field;
            vect = proxyInput.node;
        }
    }
    const edges = {};
    // create outputs for interface
    log.debug(`Node: node.edge.length ${vect.edges.length}`);
    vect.edges.forEach((edge: Edge) => {
        Object.defineProperty(edges, edge.field, {
            set: async (setterVal: any) => {
                async function setter(val: any): Promise<void> {
                    log.debug(`Node: Edge setter invoked. field ${edge.field}, edge.connectors.length ${edge.connectors.length}, node.id ${vect.id}, graph.id, ${graph.id}`);
                    for (const connector of edge.connectors) {
                        if (connector.graphId !== graph.id) {
                            graph = await scheduler.graphLoader.load(scheduler.getGraphPath(connector.graphId, connector.version));
                        }
                        const nodeNext = graph.nodes.find((v: Node) => {
                            return connector.nodeId === v.id;
                        });
                        if (nodeNext) {
                            log.debug(`Node: Edge.execute nodeNext.id ${nodeNext.id} nodeNext.graphId ${nodeNext.graphId}`);
                            const start = Date.now();
                            scheduler.dispatchEvent("beginconnector", {
                                time: start,
                                id: newId(),
                                connector,
                                value: val,
                            } as ConnectorEvent);
                            edgeExecute(scheduler, graph, nodeNext, connector.field, val).then(() => {
                                const end = Date.now();
                                scheduler.dispatchEvent("endconnector", {
                                    time: end,
                                    duration: end - start,
                                    id: newId(),
                                    connector,
                                    value: val,
                                } as ConnectorEvent);
                            }).catch((err) => {
                                log.error(err.stack);
                                scheduler.dispatchEvent("error", {
                                    id: newId(),
                                    time: Date.now(),
                                    err,
                                    message: err.toString(),
                                    edgeField: edge.field,
                                    connectorId: connector.id,
                                    nodeId: vect.id,
                                    graphId: graph.id,
                                } as EdgeError);
                            });
                        } else {
                            const err = new Error(`Connector refers to a node edge that does not exist.  Connector.id: ${connector.id}`);
                            log.error(err.stack);
                            scheduler.dispatchEvent("error", {
                                id: newId(),
                                time: Date.now(),
                                err,
                                message: err.toString(),
                                edgeField: edge.field,
                                connectorId: connector.id,
                                nodeId: vect.id,
                                graphId: graph.id,
                            } as EdgeError);
                        }
                    }
                }
                setter(setterVal).then(() => {
                    log.debug('Async setter completed successfully.');
                }).catch((err) => {
                    const er = new Error(`Node: Edge setter error. field ${edge.field}, node.id ${vect.id}. Error: ${err}`);
                    log.error(er.stack);
                    scheduler.dispatchEvent("error", {
                        id: newId(),
                        time: Date.now(),
                        err: er,
                        message: er.toString(),
                        edgeField: edge.field,
                        nodeId: vect.id,
                        graphId: graph.id,
                    } as EdgeError);
                });
            }
        });
    });
    // ensure the node has a cache for private use
    scheduler.nodeCache[vect.id] = scheduler.nodeCache[vect.id] || {};
    // provide interface for invoking code
    const nodeInterface = {
        scheduler,
        edges,
        state: scheduler.state,
        field,
        value,
        node: vect,
        cache: scheduler.nodeCache[vect.id],
        graph,
        data: vect.data,
        properties: vect.properties,
    } as NodeInterface;
    if (vect.template.set) {
        log.debug(`Node: Parse and run template for node.id: ${node.id} template length ${vect.template.set.length}`);
        parseAndRun(vect.template.set, nodeInterface).then((setResult: any) => {
            scheduler.dispatchEvent("afterSet", {
                id: newId(),
                return: setResult,
                time: Date.now(),
                nodeInterface,
            } as NodeSetEvent);
        }).catch((err) => {
            const er = err;
            scheduler.logger.error(`Node: set function caused an error: ${err.stack}`);
            scheduler.dispatchEvent("error", {
                id: newId(),
                time: Date.now(),
                err,
                message: err.toString(),
                nodeId: vect.id,
                graphId: graph.id,
                field,
            } as EdgeError);
        });
    } else if (!vect.linkedGraph) {
        const err = new Error(`Node: No template for set found on node.id ${node.id}`);
        scheduler.logger.error(err.stack);
        scheduler.dispatchEvent("error", {
            id: newId(),
            time: Date.now(),
            err,
            message: err.toString(),
            nodeId: vect.id,
            graphId: graph.id,
            field,
        } as EdgeError);
    }
}
