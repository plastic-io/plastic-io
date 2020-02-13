import Vector from "./Vector";
/**
 * Occurs when a linked vector or graph are loaded.
 * The fetch function in the global scope is used to fetch URLs.
 * This behavior can be overridden by adding an event listener to
 * the load even and calling 'setValue' with the Vector or Graph
 * requested.
 */
export interface LoadEvent extends SchedulerEvent {
    /** The unique UUID of the event */
    id: string;
    /** Time the event occurred */
    time: number;
    /** How long the event took */
    duration?: number;
    /** Calling the setValue function will set the linked graph or vector and
     * stop the default global fetch function from being called
     */
    setValue: Function; // tslint:disable-line
}
/** Connects two vector edges together */
export interface Connector {
    /** Unique id of the connector */
    id: string;
    /** Vector.id this connector connects to */
    vectorId: string;
    /** Edge name this connector connects to */
    field: string;
    /** The graph id the vector belongs to */
    graphId: string;
    /** The graph version this vector belongs to */
    version: number;
}
/** Maps a host vector's edges to the edges on the inner graph */
export interface FieldMap {
    /** The vector ID this field mapping belongs to */
    id: string;
    /** The edge name this field mapping belong to */
    field: string;
}
/**
 * Used to host vector template data.  Unless extended to contain
 * other templates, for example Vue or React templates, this interface will only
 * contain the main set property that hold ESNEXT source code that runs
 * when the vector's setter is set
 */
export interface VectorTemplate {
    set: string;
}
/** Used internally to represent a linked vector */
export interface LinkedVector {
    /** The vector.id of the linked vector */
    id: string;
    /** The version number of the linked vector */
    version: number;
    /** Once loaded, the linked vector is stored here */
    vector?: Vector;
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
/** Interface provided to vector set methods at runtime */
export interface VectorInterface {
    /** The vector being set */
    vector: Vector;
    /** The name of the edge being set */
    field: string;
    /** The value passed to the edge */
    value: any;
    /** All edges on this vector */
    edges: object;
    /** The state object on this scheduler */
    state: object;
    /** The vector specific cache object */
    cache: object;
    /** The graph that this vector belongs to */
    graph: Graph;
    /**
     * Data associated with this vector.  Data can be any type, it depends on
     * the vector author's purpose for the vector.  Data is meant to be
     * non volatile information related to the domain of this vector.
     */
    data: any;
    /**
     * Properties associated with this vector.  Properties is used by
     * the graph domain user interface or other non volatile graph or vector
     * domain interfaces.
     */
    properties: object;
}
/**
 * This event is dispatched after vector set code has been executed.
 * The global return value for the vector set code can be found here.
 */
export interface VectorSetEvent extends SchedulerEvent {
    /** If present, an error occurred and this is the error. */
    err?: Error;
    /**
     * Return value if any.  This requires the set function
     * to return in the global scope.  This has no impact on graph execution,
     * the value does not connect to other vectors.
     */
    return: any;
    /** The vector interface passed to the set function. */
    vectorInterface: VectorInterface;
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
/** Represents the base graph schema */
export interface Graph {
    id: string;
    vectors: Vector[];
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
}
/** Data generated by the initial invocation of the graph. */
export interface ExecutionResult {
    vectors: Vector[];
}
/** An event emitted during vector invocation scheduling. */
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
}
/** Not an error. */
export interface Warning extends SchedulerEvent {
    /** Warning message */
    message: string;
}
