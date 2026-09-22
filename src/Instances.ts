import type Scheduler from "./Scheduler";
import type Node from "./Node";
import {newId} from "./Shared";
import type {Graph, LinkedGraph} from "./Shared";

/**
 * Linked graphs as calls, not as copies made in advance (2.3).
 *
 * A node can carry another graph. Until now that arrangement was resolved
 * once: the first value to arrive loaded the inner document, wired the host's
 * output connectors onto its nodes, and marked it `loaded`. Every later value
 * — and every other node carrying the same graph — reached those same node
 * objects, with the same `data` on them.
 *
 * That is fine for a subgraph used once. It is wrong for a subgraph used
 * twice, because both uses share one set of nodes, and it makes recursion
 * impossible: a graph that contains itself would need the inner copy to be a
 * different copy each time round, and there was only ever one.
 *
 * So a linked graph is instantiated **when a value arrives at it**. The
 * instance is named by the path of host nodes it was reached through, which
 * gives three things at once:
 *
 *   - the same host reached twice is the same instance, so its nodes keep
 *     their `data` between calls — state that belongs to that use of the
 *     subgraph and to nothing else;
 *   - two hosts carrying the same graph are two instances that share nothing;
 *   - a graph reached through itself is a *deeper* path, so it is a new
 *     instance with its own everything. That is recursion, and the path length
 *     is the depth.
 *
 * Nothing here decides when recursion stops — the graph does, the way any
 * recursive function does. The depth ceiling is the safety net for one that
 * does not, and it fails with the path so it is obvious what happened.
 */

export interface GraphInstance {
    /** The host nodes this instance was reached through, outermost first. */
    path: string[];
    /** How many linked graphs deep this is; the root graph is 0. */
    depth: number;
    /** This instance's own copy of the inner document. */
    graph: Graph;
    /** The graph this instance was reached from, so what leaves it can get back. */
    parent: Graph;
    /** Scratch belonging to this instance alone; `state` remains the graph's. */
    state: {[key: string]: any};
}

/** Where a graph object sits in the tree of instances, if it is one. */
const INSTANCE = "__instance";

export const instanceOf = (graph: Graph): GraphInstance | undefined => (graph as any)[INSTANCE];

export const instancePathOf = (graph: Graph): string[] => {
    const instance = instanceOf(graph);
    return instance ? instance.path : [];
};

/** How deep linked graphs may be instantiated before it is called a runaway. */
export const DEFAULT_LINKED_GRAPH_DEPTH = 32;

export class LinkedGraphDepthError extends Error {
    path: string[];
    constructor(path: string[], limit: number) {
        super(`Linked graphs went ${path.length} deep (limit ${limit}): ${path.join(" → ")}. `
            + "A graph that contains itself has to stop itself; this is the ceiling, not the plan.");
        this.name = "LinkedGraphDepthError";
        this.path = path;
    }
}

/** A value copied where it can be, kept where it cannot (a function, a handle). */
function copyValue(value: any): any {
    if (value === null || typeof value !== "object") {
        return value;
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (err) {
        return value;
    }
}

/**
 * A copy of a document that shares nothing an instance can change: its own
 * nodes, edges, connectors, data and properties.
 *
 * What it deliberately does **not** copy is the document a linked node
 * carries. That reference is the graph itself when a graph contains itself,
 * and copying it would either never end or refuse to try — and it is not
 * needed, because reaching that node makes an instance of it in turn.
 */
function copyGraph(graph: Graph): Graph {
    return {
        ...graph,
        nodes: (graph.nodes || []).map((node: Node) => {
            const copy: any = {
                ...node,
                data: copyValue(node.data),
                properties: copyValue(node.properties),
                edges: (node.edges || []).map((edge) => ({
                    ...edge,
                    connectors: (edge.connectors || []).map((connector) => ({...connector})),
                })),
            };
            if (node.linkedGraph) {
                copy.linkedGraph = {...node.linkedGraph};
            }
            return copy as Node;
        }),
    };
}

/** A document as it was before anything ran; instances are made from this. */
export function pristine(graph: Graph): Graph {
    return copyGraph(graph);
}

/**
 * The instance a value arriving at this host node belongs to, made if this is
 * the first time that call has been made.  Loading happens here, at the moment
 * of the call, so a graph that is only reached sometimes is only loaded then.
 */
export async function instanceFor(scheduler: Scheduler, host: Node, parent: Graph): Promise<GraphInstance> {
    const linked = host.linkedGraph as LinkedGraph;
    const path = instancePathOf(parent).concat([host.id]);
    const key = path.join("/");
    const existing = scheduler.instances[key];
    if (existing) {
        return existing;
    }
    const limit = typeof scheduler.options.linkedGraphDepth === "number"
        ? scheduler.options.linkedGraphDepth
        : DEFAULT_LINKED_GRAPH_DEPTH;
    if (path.length > limit) {
        throw new LinkedGraphDepthError(path, limit);
    }
    // The document, at the moment it is needed rather than in advance.
    const loaded = linked.graph
        ? linked.graph
        : await scheduler.graphLoader.load(scheduler.getGraphPath(linked.id, linked.version));
    if (!loaded) {
        throw new Error(`Critical Error: Linked graph not found on node.id: ${host.id}`);
    }
    // The document as it was, not as the run has left it: a graph that
    // contains itself *is* the graph running, and a call must not inherit what
    // its caller was in the middle of.
    let document = scheduler.documents.get(loaded);
    if (!document) {
        document = copyGraph(loaded);
        scheduler.documents.set(loaded, document);
    }
    const graph = copyGraph(document);
    const instance: GraphInstance = {path, depth: path.length, graph, parent, state: {}};
    (graph as any)[INSTANCE] = instance;
    seedFromHost(graph, linked);
    wireOutputs(graph, host, linked);
    scheduler.instances[key] = instance;
    scheduler.logger.debug(`Instances: made ${key} of graph ${document.id} at depth ${path.length}`);
    return instance;
}

/** What the host says this use of the subgraph starts with. */
function seedFromHost(graph: Graph, linked: LinkedGraph): void {
    const data = (linked.data || {}) as {[key: string]: any};
    const properties = (linked.properties || {}) as {[key: string]: any};
    graph.nodes.forEach((node: Node) => {
        if (Object.prototype.hasOwnProperty.call(data, node.id)) {
            node.data = copyValue(data[node.id]);
        }
        if (Object.prototype.hasOwnProperty.call(properties, node.id)) {
            node.properties = properties[node.id];
        }
    });
}

/**
 * What leaves this instance leaves by the host's connectors.  They are copied
 * in, not moved, because the host is shared by every instance of it and the
 * document must come out of a run the way it went in.
 */
function wireOutputs(graph: Graph, host: Node, linked: LinkedGraph): void {
    const outputs = (linked.fields && linked.fields.outputs) || {};
    Object.keys(outputs).forEach((hostField: string) => {
        const output = (outputs as any)[hostField];
        if (!output || !output.id) {
            return;
        }
        const hostEdge = host.edges.find((edge) => edge.field === hostField);
        if (!hostEdge || !hostEdge.connectors.length) {
            return;
        }
        const innerNode = graph.nodes.find((node: Node) => node.id === output.id);
        if (!innerNode) {
            return;
        }
        let innerEdge = innerNode.edges.find((edge) => edge.field === output.field);
        if (!innerEdge) {
            innerEdge = {field: output.field, connectors: []};
            innerNode.edges.push(innerEdge);
        }
        hostEdge.connectors.forEach((connector) => {
            if (!innerEdge!.connectors.some((c) => c.id === connector.id)) {
                innerEdge!.connectors.push({...connector, id: newId()});
            }
        });
    });
}

/**
 * The graph of the call named by this path, made if it has not been made yet.
 *
 * A path is the chain of host node ids a call was reached through, which is
 * what an instance is named by — so this is how something *outside* an
 * execution enters one: a hop handed to the other domain says which call it
 * belongs to, and the domain that answers it has to stand in the same call
 * rather than in a graph that merely looks like it.
 */
export async function instanceAt(scheduler: Scheduler, path: string[]): Promise<Graph> {
    let graph: Graph = scheduler.graph;
    for (const hostId of path || []) {
        const host = (graph.nodes || []).find((node: Node) => node.id === hostId);
        if (!host) {
            throw new Error(`No node ${hostId} in ${graph.id}: the call ${(path || []).join("/")} cannot be entered`);
        }
        if (!host.linkedGraph) {
            throw new Error(`Node ${hostId} carries no graph: the call ${(path || []).join("/")} cannot be entered`);
        }
        const instance = await instanceFor(scheduler, host, graph);
        graph = instance.graph;
    }
    return graph;
}

/**
 * The graph a connector points into.  A connector inside an instance that
 * names another graph is nearly always on its way back out to the one that
 * called it, and that graph is in memory — asking the loader for it would find
 * a document, not the instance, and the value would arrive in the wrong copy.
 */
export async function graphForConnector(scheduler: Scheduler, graph: Graph, connector: {graphId: string; version: number}): Promise<Graph> {
    if (connector.graphId === graph.id) {
        return graph;
    }
    let at: Graph | undefined = graph;
    const seen = new Set<Graph>();
    while (at && !seen.has(at)) {
        seen.add(at);
        const instance = instanceOf(at);
        at = instance ? instance.parent : undefined;
        if (at && at.id === connector.graphId) {
            return at;
        }
    }
    return scheduler.graphLoader.load(scheduler.getGraphPath(connector.graphId, connector.version));
}
