import Edge, {execute as edgeExecute} from "./Edge";
import {parseScript} from 'meriyah';
import {generate} from "escodegen";
import Scheduler from "./Scheduler";
import {GraphInstance, instanceFor, instanceOf, graphForConnector} from "./Instances";
import {ConnectorEvent, Graph, newId, EdgeError, NodeTemplate,
    LinkedNode, LinkedGraph, NodeInterface, NodeSetEvent, HostInterface, ObservationEvent, EventIds} from "./Shared";
import {Span, Execution, ExecutionCancelled} from "./Execution";
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
const SET_PARAMETERS = ["scheduler", "graph", "cache", "node", "field",
    "state", "value", "edges", "data", "properties", "require", "host", "instance"];

/**
 * The native AsyncFunction constructor.
 *
 * Asked for at runtime through `Function`, because this package compiles to
 * ES5 and TypeScript rewrites `async function(){}` into a generator helper
 * whose constructor is the plain `Function`: node code containing `await`
 * was a syntax error in 2.0 for that reason alone.
 */
function asyncFunctionConstructor(): any {
    try {
        return new Function("return Object.getPrototypeOf(async function(){}).constructor")(); // tslint:disable-line
    } catch (err) {
        return Function;
    }
}
const AsyncFunction = asyncFunctionConstructor();

/**
 * Compile a set function once per source text.
 *
 * `direct` hands the source to `AsyncFunction` as written: the body of an
 * async function already allows top-level `await` and `return`, so nothing
 * needs regenerating and every syntax the runtime knows is available.  When
 * the source does not parse, meriyah is consulted only for a located message.
 * `meriyah` keeps the 2.0 parse-then-regenerate path for embedders that
 * depend on it.
 */
export function compile(scheduler: Scheduler, code: string): Function { // tslint:disable-line
    const mode = scheduler.options.compile || "direct";
    const key = mode + ":" + code;
    if (scheduler.compiled[key]) {
        return scheduler.compiled[key];
    }
    let fn;
    if (mode === "meriyah") {
        const ast = parseScript(code, {loc: true, module: true, next: true, globalReturn: true});
        fn = new AsyncFunction(...SET_PARAMETERS, generate(ast));
    } else {
        try {
            fn = new AsyncFunction(...SET_PARAMETERS, code);
        } catch (err) {
            // a parse error with a location beats "Unexpected token"
            parseScript(code, {loc: true, module: true, next: true, globalReturn: true});
            throw err;
        }
    }
    scheduler.compiled[key] = fn;
    return fn;
}

/** The `host` binding for one invocation: identity, cancellation, observations, plus whatever the embedder adds. */
function buildHost(scheduler: Scheduler, execution: Execution | undefined, nodeInterface: NodeInterface): HostInterface {
    const base: HostInterface = {
        executionId: execution ? execution.executionId : "",
        get cancelled(): boolean {
            return execution ? execution.token.cancelled : false;
        },
        signal: execution ? execution.token.signal : undefined,
        throwIfCancelled(): void {
            if (execution) {
                execution.token.throwIfCancelled();
            }
        },
        emit(kind: string, data?: any): void {
            if (execution && !execution.observe()) {
                return;
            }
            scheduler.dispatchEvent("observation", {
                id: newId(),
                time: Date.now(),
                kind,
                data,
                nodeId: nodeInterface.node.id,
                graphId: nodeInterface.graph.id,
                executionId: execution ? execution.executionId : undefined,
            } as ObservationEvent);
        },
        now(): number {
            return Date.now();
        },
        random(): number {
            return Math.random();
        },
    };
    const extra = typeof scheduler.options.host === "function"
        ? scheduler.options.host({execution, nodeInterface})
        : scheduler.options.host;
    return extra ? Object.assign(base, extra) : base;
}

/** Utility to parse and run nodes.  Used internally to run the node's set function. */
function parseAndRun(code: string, nodeInterface: NodeInterface, execution?: Execution): Promise<any> {
    return new Promise(async (resolve, reject) => {
        /**
         * Run the node here, in this realm, with the 2.0 parameter list.  A
         * runtime that contains node code elsewhere (a V8 isolate, a worker,
         * another machine) supplies `options.executeNode` and calls this only
         * for the nodes it chooses to keep in process.
         */
        const runInProcess = () => {
            const nodeFn = compile(nodeInterface.scheduler, code);
            nodeInterface.scheduler.logger.debug(`Node: about to execute compiled function.`);
            return Promise.resolve(nodeFn.call(
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
                nodeInterface.host,
                nodeInterface.instance,
            ));
        };
        try {
            nodeInterface.scheduler.dispatchEvent("set", {
                id: newId(),
                nodeId: nodeInterface.node.id,
                graphId: nodeInterface.node.graphId,
                field: nodeInterface.field,
                time: Date.now(),
                nodeInterface,
                executionId: execution ? execution.executionId : undefined,
                setContext(val: any) {
                    nodeInterface.scheduler.logger.debug(`Node: setContext setting context of node.`);
                    nodeInterface.context = val;
                },
            } as NodeSetEvent);
            const executor = nodeInterface.scheduler.options.executeNode;
            const run = executor
                ? Promise.resolve(executor({code, nodeInterface, execution, runInProcess}))
                : runInProcess();
            run
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
export function getLinkedInputs(vect: Node, field: string, scheduler: Scheduler, within?: Graph): any {
    const log = scheduler.logger;
    // `within` is the instance this call belongs to; without one this is the
    // 2.2 behaviour, which reached into the document every use shared.
    const graph = within || vect.linkedGraph!.graph;// eslint-disable-line
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
/** Runs a contract hook; reports a violation and says whether the delivery may go on. */
function contract(scheduler: Scheduler, hook: "onInput" | "onOutput", info: any, ids: EventIds): boolean {
    const fn = scheduler.options[hook];
    if (!fn) {
        return true;
    }
    try {
        fn(info);
        return true;
    } catch (err) {
        const reject = scheduler.options.contractMode === "reject";
        scheduler.dispatchEvent(reject ? "error" : "warning", {
            id: newId(),
            time: Date.now(),
            err,
            message: "Contract violation (" + hook + "): " + err,
            code: "CONTRACT_VIOLATION",
            nodeId: info.node.id,
            field: info.field,
            ...ids,
        } as EdgeError);
        return !reject;
    }
}
/** Run connector code in isolation, creates interface.  Used internally. */
export async function execute(scheduler: Scheduler, graph: Graph, node: Node, field: string, value: any, span?: Span): Promise<any> {
    const log = scheduler.logger;
    log.debug(`Node: Begin execute node.id ${node.id}, field ${field}`);
    const execution = span ? span.execution : undefined;
    const ids: EventIds = span ? {executionId: span.execution.executionId, spanId: span.spanId, parentSpanId: span.parentSpanId} : {};
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
    /**
     * A linked graph is a call (2.3).  The instance this value belongs to is
     * named by the host nodes it was reached through, so the same use keeps
     * its nodes between calls, two uses share nothing, and a graph reached
     * through itself is a deeper path — a new instance, with its own data.
     * Recursion is that, and nothing more; a graph that does not stop itself
     * meets the depth ceiling and fails saying which path it took.
     */
    // Every node running inside an instance belongs to it, not only the one
    // the call arrived at: the graph a node is running in *is* the instance, so
    // it is asked rather than tracked.  Without this, a node two connectors
    // into a called graph had no idea which call it was part of, and per-instance
    // state stopped at the front door.
    let instance: GraphInstance | undefined = instanceOf(graph);
    if (vect.linkedGraph) {
        // A graph that cannot be instantiated — it will not load, or the
        // recursion has gone past the ceiling — throws from here and is
        // reported by the edge, the way every other failure in a node is.
        instance = await instanceFor(scheduler, vect, graph);
        graph = instance.graph;
        const proxyInput = getLinkedInputs(vect, field, scheduler, instance.graph);
        field = proxyInput.field;
        vect = proxyInput.node;
    }
    const edges = {};
    // create outputs for interface
    log.debug(`Node: node.edge.length ${vect.edges.length}`);
    vect.edges.forEach((edge: Edge) => {
        Object.defineProperty(edges, edge.field, {
            set: (setterVal: any) => {
                // An emission after the execution has ended (a UI node reacting
                // to a click, a timer) starts an execution of its own, so it is
                // tracked, budgeted and attributed like any other.
                let current: Execution | undefined = execution;
                let parentSpan: Span | undefined = span;
                if (current && current.isSettled) {
                    current = scheduler.beginExecution(vect.url, current.executionId);
                    parentSpan = current.span();
                }
                const setterIds: EventIds = current ? {executionId: current.executionId, spanId: parentSpan ? parentSpan.spanId : undefined} : {};
                async function setter(val: any): Promise<void> {
                    log.debug(`Node: Edge setter invoked. field ${edge.field}, edge.connectors.length ${edge.connectors.length}, node.id ${vect.id}, graph.id, ${graph.id}`);
                    if (current) {
                        current.token.throwIfCancelled();
                        if (!current.fanOut(edge.connectors.length)) {
                            return;
                        }
                    }
                    if (!contract(scheduler, "onOutput", {node: vect, field: edge.field, value: val, executionId: current ? current.executionId : ""}, setterIds)) {
                        return;
                    }
                    for (const connector of edge.connectors) {
                        if (current && current.token.cancelled) {
                            break;
                        }
                        // The connector may point into another graph; that graph is
                        // loaded for this connector only and never replaces `graph`
                        // for the node's remaining connectors (2.0 reassigned it).
                        // The connector may point into another graph — back out
                        // to the instance that called this one, or to a document
                        // the loader has.  The same-graph case stays synchronous:
                        // an await here, even on a value, would defer delivery a
                        // microtask and a 2.0 graph would stop working.
                        let targetGraph: Graph = graph;
                        if (connector.graphId !== graph.id) {
                            targetGraph = await graphForConnector(scheduler, graph, connector);
                        }
                        const nodeNext = targetGraph.nodes.find((v: Node) => {
                            return connector.nodeId === v.id;
                        });
                        if (nodeNext) {
                            if (!contract(scheduler, "onInput", {node: nodeNext, field: connector.field, value: val, connector, executionId: current ? current.executionId : ""}, setterIds)) {
                                continue;
                            }
                            log.debug(`Node: Edge.execute nodeNext.id ${nodeNext.id} nodeNext.graphId ${nodeNext.graphId}`);
                            const start = Date.now();
                            scheduler.dispatchEvent("beginconnector", {
                                time: start,
                                id: newId(),
                                connector,
                                value: val,
                                ...setterIds,
                            } as ConnectorEvent);
                            const childSpan = current ? current.span(parentSpan) : undefined;
                            const delivery = edgeExecute(scheduler, targetGraph, nodeNext, connector.field, val, childSpan).then(() => {
                                const end = Date.now();
                                scheduler.dispatchEvent("endconnector", {
                                    time: end,
                                    duration: end - start,
                                    id: newId(),
                                    connector,
                                    value: val,
                                    ...setterIds,
                                } as ConnectorEvent);
                            }).catch((err) => {
                                if (err instanceof ExecutionCancelled) {
                                    return;
                                }
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
                                    ...setterIds,
                                } as EdgeError);
                            });
                            if (current) {
                                current.track(delivery);
                            }
                        } else {
                            const err = new Error(`Connector refers to a node edge that does not exist.  Connector.id: ${connector.id}`);
                            log.error(err.stack);
                            if (current) {
                                current.errors += 1;
                            }
                            scheduler.dispatchEvent("error", {
                                id: newId(),
                                time: Date.now(),
                                err,
                                message: err.toString(),
                                edgeField: edge.field,
                                connectorId: connector.id,
                                nodeId: vect.id,
                                graphId: graph.id,
                                ...setterIds,
                            } as EdgeError);
                        }
                    }
                }
                const run = setter(setterVal).then(() => {
                    log.debug('Async setter completed successfully.');
                }).catch((err) => {
                    if (err instanceof ExecutionCancelled) {
                        return;
                    }
                    if (current) {
                        current.errors += 1;
                    }
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
                        ...setterIds,
                    } as EdgeError);
                });
                if (current) {
                    current.track(run);
                    if (current !== execution) {
                        current.arm();
                    }
                }
            }
        });
    });
    // ensure the node has a cache for private use; inside an instance the
    // cache belongs to that instance, as its data does
    const cacheKey = instance ? `${instance.path.join("/")}/${vect.id}` : vect.id;
    scheduler.nodeCache[cacheKey] = scheduler.nodeCache[cacheKey] || {};
    // provide interface for invoking code
    const nodeInterface = {
        scheduler,
        edges,
        state: scheduler.state,
        instance: instance ? {path: instance.path, depth: instance.depth, state: instance.state} : undefined,
        field,
        value,
        node: vect,
        cache: scheduler.nodeCache[cacheKey],
        graph,
        data: vect.data,
        properties: vect.properties,
        executionId: execution ? execution.executionId : undefined,
    } as NodeInterface;
    nodeInterface.host = buildHost(scheduler, execution, nodeInterface);
    if (vect.template.set) {
        log.debug(`Node: Parse and run template for node.id: ${node.id} template length ${vect.template.set.length}`);
        // Awaited, so `endedge` means the set function has finished (2.0.3 let
        // it run past the edge); deliveries it started are tracked on their own.
        const run = parseAndRun(vect.template.set, nodeInterface, execution).then((setResult: any) => {
            scheduler.dispatchEvent("afterSet", {
                id: newId(),
                return: setResult,
                time: Date.now(),
                nodeInterface,
                nodeId: vect.id,
                graphId: graph.id,
                field,
                ...ids,
            } as NodeSetEvent);
        }).catch((err) => {
            if (err instanceof ExecutionCancelled) {
                return;
            }
            if (execution) {
                execution.errors += 1;
            }
            scheduler.logger.error(`Node: set function caused an error: ${err.stack}`);
            scheduler.dispatchEvent("afterSet", {
                id: newId(),
                err,
                time: Date.now(),
                nodeInterface,
                nodeId: vect.id,
                graphId: graph.id,
                field,
                ...ids,
            } as NodeSetEvent);
            scheduler.dispatchEvent("error", {
                id: newId(),
                time: Date.now(),
                err,
                message: err.toString(),
                nodeId: vect.id,
                graphId: graph.id,
                field,
                ...ids,
            } as EdgeError);
        });
        if (execution) {
            execution.track(run);
        }
        await run;
    } else if (!vect.linkedGraph) {
        const err = new Error(`Node: No template for set found on node.id ${node.id}`);
        scheduler.logger.error(err.stack);
        if (execution) {
            execution.errors += 1;
        }
        scheduler.dispatchEvent("error", {
            id: newId(),
            time: Date.now(),
            err,
            message: err.toString(),
            nodeId: vect.id,
            graphId: graph.id,
            field,
            ...ids,
        } as EdgeError);
    }
}
