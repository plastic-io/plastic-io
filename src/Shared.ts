import Node from "./Node";
import Scheduler from "./Scheduler";
/**
 * Occurs when a linked node or graph are loaded.
 * The fetch function in the global scope is used to fetch URLs.
 * This behavior can be overridden by adding an event listener to
 * the load even and calling 'setValue' with the Node or Graph
 * requested.
 *
 * ```typescript
 * scheduler.addEventListener("load", async load(context: any, e: any) {
 *      const item = await cstore.get(e.url);
 *      e.setValue(item);
 * });
 * ```
 *
 */
export interface LoadEvent extends SchedulerEvent {
    /** The unique UUID of the event */
    id: string;
    /** Calling the setValue function will set the linked graph or node and
     * stop the default global fetch function from being called
     */
    setValue: Function; // tslint:disable-line
    /** The url of the artifact */
    url: string;
}
/** Occurs when data is sent to a node via an edge connector. */
export interface ConnectorEvent extends SchedulerEvent {
    connector: Connector;
}
/** Connects two node edges together */
export interface Connector {
    /** Unique id of the connector */
    id: string;
    /** Node.id this connector connects to */
    nodeId: string;
    /** Edge name this connector connects to */
    field: string;
    /** The graph id the node belongs to */
    graphId: string;
    /** The graph version this node belongs to */
    version: number;
}
/** Maps a host node's edges to the edges on the inner graph */
export interface FieldMap {
    /** The node ID this field mapping belongs to */
    id: string;
    /** The edge name this field mapping belong to */
    field: string;
    /** The type of this mapping */
    type: string;
    /** External flag */
    external: boolean;
}
/**
 * Used to host node template data.  Unless extended to contain
 * other templates, for example Vue or React templates, this interface will only
 * contain the main set property that hold ESNEXT source code that runs
 * when the node's setter is set
 */
export interface NodeTemplate {
    set: string;
}
/** Used internally to represent a linked node */
export interface LinkedNode {
    /** The node.id of the linked node */
    id: string;
    /** The version number of the linked node */
    version: number;
    /** Once loaded, the linked node is stored here */
    node?: Node;
    /** When loaded, this value is true, otherwise, it is false. */
    loaded: boolean;
}
/** Used internally to represent a linked graph and related field mapping, properties and data. */
export interface LinkedGraph {
    /** THe id of the linked graph */
    id: string;
    /** The version number of the linked graph */
    version: number;
    /** Once loaded, this hold the linked graph */
    graph: Graph;
    /** When loaded, this value is true, otherwise, it is false. */
    loaded: boolean;
    /** Data mapped onto the linked graph from the host graph */
    data: {
        [key: string]: any;
    };
    /** Properties mapped onto the linked graph from the host graph */
    properties: {
        [key: string]: object;
    };
    /** Edges mapped onto the linked graph from the host graph */
    fields: {
        inputs: {
            [key: string]: FieldMap;
        };
        outputs: {
            [key: string]: FieldMap;
        };
    };
}
/** Interface provided to node set methods at runtime */
export interface NodeInterface {
    /** The scheduler */
    scheduler: Scheduler;
    /** The node being set */
    node: Node;
    /** The name of the edge being set */
    field: string;
    /** The value passed to the edge */
    value: any;
    /** All edges on this node */
    edges: object;
    /** The state object on this scheduler */
    state: object;
    /** The node specific cache object */
    cache: object;
    /** The graph that this node belongs to */
    graph: Graph;
    /**
     * Data associated with this node.  Data can be any type, it depends on
     * the node author's purpose for the node.  Data is meant to be
     * non volatile information related to the domain of this node.
     */
    data: any;
    /**
     * Properties associated with this node.  Properties is used by
     * the graph domain user interface or other non volatile graph or node
     * domain interfaces.
     */
    properties: object;
    /**
     * User setable node set context (value of `this` during set).
     * this is setable on a per node set instance basis by subscribing to
     * set and running e.setContext.
     */
    context: any;
}
/**
 * This event is dispatched before and after node set code has been executed.
 * The global return value for the node set code can be found here.
 */
export interface NodeSetEvent extends SchedulerEvent {
    /** If present, an error occurred and this is the error. */
    err?: Error;
    /**
     * Return value if any.  This requires the set function
     * to return in the global scope.  This has no impact on graph execution,
     * the value does not connect to other nodes.  This value is only present
     * on the afterSet event.
     */
    return?: any;
    /** The node interface passed to the set function. */
    nodeInterface: NodeInterface;
    /** The nodeId where the set event occured */
    nodeId: string;
    /** The graphId where the set event occured */
    graphId: string;
    /** The field where the set event occured */
    field: string;
    /** Calling the setContext function will allow you to set the context of the
     * set function.  This is useful to do setup on every set function that runs
     * to attach context data to the function
     */
    setContext: Function; // tslint:disable-line
}
/** Used to hold the place of logger methods when no logger is specified */
export function nullFunction(): void {
    return;
}
/** Used to hold the place of logger when no logger is specified */
export const nullLogger: Logger = {
    log: nullFunction,
    info: nullFunction,
    debug: nullFunction,
    error: nullFunction,
    warn: nullFunction,
};
/** To see the log output of the Scheduler, attach a W3C standard logger to the scheduler constructor */
export interface Logger {
    /** Not used much */
    log: Function; // tslint:disable-line
    /** Maybe important info */
    warn: Function; // tslint:disable-line
    /** Really unimportant stuff, unless everything is breaking, then it's really important. */
    debug: Function; // tslint:disable-line
    /** Mildly interesting data, not used much. */
    info: Function; // tslint:disable-line
    /** Always critical to see when failures happen.  This is also cloned in the 'error' event. */
    error: Function; // tslint:disable-line
}
/** Creates a new v4 UUID */
export function newId(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        // tslint:disable-next-line
        var r = Math.random() * 16 | 0, v = c == "x" ? r : (r & 0x3 | 0x8); // eslint-disable-line 
        return v.toString(16);
    });
}
/**
 * Graphs are the containers of your Plastic-IO programs.  Graphs contain a collection of {@link Node}s.
 * Nodes contain a unit of executable code, along with view, test and any other code templates that
 * constitute the functionality of the unit of code.  See {@link Node} for more information.
 *
 * Graphs can be linked into other graphs.  When linked, the graph appears to be a node on the host graph.
 * A special map (See {@link Node.linkedGraph}, {@link LinkedGraph.fields}) is created based on any Node edges with the boolean value `external` set to true.
 * This map makes specified edges on the internal graph connectable on the host graph via edges that will
 * appear on the linked graph.
 *
 * To "start" a graph you typically point {@link Scheduler.url} at a {@link Node.url}, which will invoke the Node's set function ({@link NodeTemplate.set})
 */
export interface Graph {
    id: string;
    url: string;
    nodes: Node[];
    properties: GraphProperties;
    version: number;
}
/** Graph properties */
export interface GraphProperties {
    /** Name of the graph */
    name: string;
    /** Description of the graph */
    description: string;
    /** Who created the graph */
    createdBy: string;
    /** When the graph was created */
    createdOn: Date;
    /** When the graph was last updated */
    lastUpdate: Date;
    /** When true, this graph can be imported into other graphs */
    exportable: boolean;
    /** The height of this graph when imported */
    height: number;
    /** The width of this graph when imported */
    width: number;
    /** The graph's icon */
    icon: string;
}
/** Data generated by the initial invocation of the graph. */
export interface ExecutionResult {
    nodes: Node[];
}
/** An event emitted during node invocation scheduling. */
export interface SchedulerEvent {
    /** Unique ID of the event */
    id: string;
    /** The time the event occurred on */
    time: number;
    /** How long the event took when applicable */
    duration?: number;
}
/** An error that occurred while traversing an edge.  Most runtime and user errors occur here */
export interface EdgeError extends SchedulerEvent {
    /** Standard error */
    err: Error;
    /** The node the error occured on */
    nodeId?: string;
}
/** Not an error. */
export interface Warning extends SchedulerEvent {
    /** Warning message */
    message: string;
}
