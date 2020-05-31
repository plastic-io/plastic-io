import Vector from "./Vector";
import {execute} from "./Edge";
import {ConnectorEvent, LoadEvent, Graph, newId, Logger, nullLogger,
    SchedulerEvent, ExecutionResult, Warning, EdgeError, VectorSetEvent} from "./Shared";
import Loader from "./Loader";
/** 
* # Scheduler
* 
* This is the graph execution engine.  To create graphs, see [Plastic-IO Graph Editor](https://github.com/plastic-io/graph-editor).
*
* The Plastic-IO Graph Editor uses this engine to test and execute graphs in the browser.
*
* If you're trying to execute graphs in an AWS environment, you might want to check out the [Plastic-IO Graph Server](https://github.com/plastic-io/graph-server).
*
* If you want to implement the scheduler yourself and run graphs in your own way, then you have come to the right place!
*
* To begin the execution of a graph, you must first instantiate your graph in the Scheduler.
* See the {@link Scheduler.constructor} for more information on instantiation.  After you instantiate
* the scheduler, you can call {@link Scheduler.url} to directly invoke a vector's edge (set function).
*
* ## Graph
* {@link Graph}s contain arrays of {@link Vector}s.  Vectors are executable units of code and can be local to the graph, or reference other vectors or graphs.
*
* # Scheduler Execution Digram
*
*                   1                         2                            3
*             +-------------+         +---------------+         +--------------------+
*             |             |         |               |         |                    |
*             |  Scheduler  |         |  Vector Edge  |         |   Edge Connector   |
*             |             |         |               |         |                    |
*             +-------------+         +---------------+         +--------------------+
*                    |                        |                            |
*                    |                        |                            |
*                    |                   +-----------------------------------------+
*                   +-+                  |   +-+        Graph Loop        +-+      |
*                   | +-Scheduler.url()----->+ |                          | |      |
*                   | |                  |   | +------edges[field]------->+ |      |
*                   | |                  |   +-+                          | |      |
*                   | |                  |    |                           | |      |
*                   | |                  |   +-+                          | |      |
*                   | |                  |   | |                          | |      |
*                   | +<----End--------------+ +<-------------------------+ |      |
*                   | |                  |   +-+                          | |      |
*                   | |                  |    |                           +-+      |
*                   | |                  +-----------------------------------------+
*                   | |                       |                            |
*                   | |                       |                            |
*                   +-+                       |                            |
*                    |                        |                            |
*                    +                        +                            +
*
*  1. Scheduler.url() calls a vector's edge (set function) based on the vector.url.
*  2. Vector Edge calls `edges[field]` which invokes n connectors referencing other vector edges
*  3. Vector edge is invoked just like step one, creating a graph loop.
*
*
*
*
*/
export default class Scheduler {
    /**
    * Occurs when the graph begins to navigate to a vector's URL via the {@link Scheduler.url} function.
    * @event
    */
    begin: (e: SchedulerEvent) => void;
    /**
    * Occurs when a connector value enters into a vector's edge (input).
    * @event
    */
    beginedge: (e: SchedulerEvent) => void;
    /**
    * Occurs after all all edge promises are completed.  Note: If your vectors do not return promises.
    * @event
    */
    endedge: (e: SchedulerEvent) => void;
    /**
    * Occurs when an error occurred during the invocation of a vector.
    * @event
    */
    error: (e: EdgeError) => void;
    /**
    * Occurs when an external resource is loaded.  You can invoke `setValue` in the event argument to override the default loader with your own.
    * @event
    */
    load: (e: LoadEvent) => void;
    /**
    * Occurs when a warning is logged.
    * @event
    */
    warning: (e: Warning) => void;
    /**
    * Occurs at the end of the initial graph promise chain.  The graph may continue to run as asynchronous functions return.
    * @event
    */
    end: (e: SchedulerEvent) => void;
    /**
    * Occurs just before set is called.  You can use `setContext` to alter the `this` context object of the vector just before the vector's set function is invoked.
    * @event
    */
    set: (e: VectorSetEvent) => void;
    /**
    * Occurs as a vector's set function has called `edges[field] = <value>;`.
    * @event
    */
    beginconnector: (e: ConnectorEvent) => void;
    /**
    * Occurs when a connector promise chain has completed after a vector's set function has called `edges[field] = <value>;`.
    * @event
    */
    endconnector: (e: ConnectorEvent) => void;
    /**
    * Occurs after a vector's set function has completed.  Contains the return value of the function.  Although this return value is present, using it is considered an anti-pattern and is only included for debugging.
    * @event
    */
    afterSet: (e: VectorSetEvent) => void;
    /** The base graph */
    graph: Graph;
    /** Logging functions */
    logger: Logger;
    /** Loader for loading graphs */
    graphLoader: Loader<Graph>;
    /** Loader for loading vectors */
    vectorLoader: Loader<Vector>;
    /** Edge traversal counter */
    sequence: number;
    /** The domain specific context object.  User defined and used by set methods. */
    context: object;
    /** Mutable state object.  This object can be changed and examined later. */
    state: object;
    /** Vector specific runtime cache object.  Used in set functions for any reason the author sees fit. */
    vectorCache: {
        [key: string]: {};
    };
    /** The parameterized path to linked graph documents */
    graphPath: string;
    /** The parameterized path to linked vector documents */
    vectorPath: string;
    /** Holds events in the event bus */
    events: {
        [key: string]: Function[]; // tslint:disable-line
    };
    /** 
    * @param graph Graph to execute.
    * @param context What will appear as the `this` object for any vector set function that executes on your graph.
    * @param state Object that will be available to vector set functions during graph execution.  You can alter this object before or after instantiating the scheduler.  See {@link VectorInterface}.
    * @param logger Optional logging function to listen to info and debug messages coming out of the scheduler.  Functional messages are emitted via the event emitter.
    *
    * ### Basic Usage
    *
    * To start graph execution, instantiate the scheduler and pass your graph to it.
    * 
    *   ```TypeScript
    *   const scheduler = new Scheduler(myGraphJSON);
    *   scheduler.url("my-graph-url");
    *   ```
    *
    * ### With Context
    *
    * You can also execute the graph and pass context variables to the vectors.
    * In the example below, vectors executing on myGraph will have access to `{foo: "bar"}` by accessing `this.foo` at runtime.
    * This allows you to attach properties like server response functions, database connections, client side component references, and many other things
    * use full to the vector's set function on runtime.
    *   ```TypeScript
    *   const scheduler = new Scheduler(myGraphJSON, {foo: "bar"});
    *   ```
    *
    * ### With State Defined
    * Vectors now have a mutable object with which they can share long running objects, data caches
    * or other resources that are expensive to instantiate per edge invocation.  State is whatever you pass into
    * before you instantiate the scheduler or at run time.  The scheduler has no opinion.
    *   ```TypeScript
    *   const scheduler = new Scheduler(myGraphJSON, {}, {foo: bar});
    *   ```
    *
    * ### Using the Logger
    * You can listen to info and debug messages emitted from the scheduler by attaching an object or class
    * that matches the {@link Logger} interface.  Which happens to be almost exactly like console.
    *   ```TypeScript
    *   const scheduler = new Scheduler(myGraphJSON, {}, {}, console);
    */
    constructor(graph: Graph, context: object = {}, state: object = {}, logger: Logger = nullLogger) {
        logger.debug("Scheduler started");
        if (!graph) {
            throw new Error("No graph was passed to the scheduler constructor.");
        }
        // the following empty methods are here for documentation of events only
        this.begin = (e: SchedulerEvent): void => { e;return; };
        this.beginedge = (e: SchedulerEvent): void => { e;return; };
        this.endedge = (e: SchedulerEvent): void => { e;return; };
        this.error = (e: SchedulerEvent): void => { e;return; };
        this.load = (e: SchedulerEvent): void => { e;return; };
        this.begin = (e: SchedulerEvent): void => { e;return; };
        this.warning = (e: SchedulerEvent): void => { e;return; };
        this.end = (e: SchedulerEvent): void => { e;return; };
        this.set = (e: SchedulerEvent): void => { e;return; };
        this.beginconnector = (e: SchedulerEvent): void => { e;return; };
        this.endconnector = (e: SchedulerEvent): void => { e;return; };
        this.afterSet = (e: SchedulerEvent): void => { e;return; };
        this.graph = graph;
        this.sequence = 0;
        this.context = context;
        this.state = state;
        this.events = {};
        this.vectorCache = {};
        this.graphPath = "artifacts/graph/{id}.{version}";
        this.vectorPath = "artifacts/vectors/{id}.{version}";
        this.logger = logger;
        this.graphLoader = new Loader<Graph>(this);
        this.vectorLoader = new Loader<Vector>(this);
        this.logger.debug("Startup parameters set");
    }
    /** Removes an event listener */
    removeEventListener(eventName: string, listener: () => void): void {
        this.logger.debug("Scheduler: Remove event " + eventName);
        if (!this.events[eventName]) {
            return;
        }
        const idx = this.events[eventName].indexOf(listener);
        if (idx === -1) {
            return;
        }
        this.events[eventName].splice(idx, 1);
    }
    /** Adds an event listener */
    addEventListener(eventName: string, listener: (eventData: ConnectorEvent| SchedulerEvent | LoadEvent | EdgeError | VectorSetEvent | Error | Warning) => void): void {
        this.logger.debug("Scheduler: Add event " + eventName);
        this.events[eventName] = this.events[eventName] || [];
        this.events[eventName].push(listener);
    }
    /** Dispatches an event */
    dispatchEvent(eventName: string, eventData: SchedulerEvent): void {
        this.logger.debug("Scheduler: Dispatch event " + eventName);
        if (this.events[eventName]) {
            for (const listener of this.events[eventName]) {
                listener.call(this, eventData);
            }
        }
    }
    getVectorPath(id: string, version: number): string {
        return this.vectorPath.replace("{id}", id).replace("{version}", version.toString());
    }
    getGraphPath(id: string, version: number): string {
        return this.graphPath.replace("{id}", id).replace("{version}", version.toString());
    }
    /** 
    *
    *    ### Simple Vector Edge Invocation
    *
    * Invoke a Vector's Edge (set function).
    * 
    *   ```TypeScript
    *   const scheduler = new Scheduler(myGraphJSON);
    *   scheduler.url("my-graph-url");
    *   ```
    *
    *    ### Invoke Edge with Value
    *
    * Invoke a Vector's Edge (set function), and send a value to the edge.
    * 
    *   ```TypeScript
    *   const scheduler = new Scheduler(myGraphJSON);
    *   scheduler.url("my-graph-url", "some value");
    *   ```
    *
    *    ### Invoke Edge with Value, and Field
    *
    * Invoke a Vector's Edge (set function), and send a value to the edge.
    * 
    *   ```TypeScript
    *   const scheduler = new Scheduler(myGraphJSON);
    *   scheduler.url("my-graph-url", "some value", "some_field");
    *   ```
    *
    *    ### Advanced: Pass Previous Execution Context
    *
    * By passing a vector instance, you can invoke vectors embedded in inner graphs.
    * 
    *   ```TypeScript
    *   const scheduler = new Scheduler(myGraphJSON);
    *   scheduler.url("my-graph-url", "some value", "some_field", myInnerVectorInstance);
    */
    async url(url: string, value: any, field: string, currentVector: Vector): Promise<ExecutionResult> {
        this.logger.debug("Scheduler: Set URL " + url);
        const start = Date.now();
        this.dispatchEvent("begin", {
            url,
            time: start,
            id: newId(),
        } as SchedulerEvent);
        let graph;
        if (currentVector && currentVector.linkedGraph && currentVector.linkedGraph.graph) {
            graph = currentVector.linkedGraph.graph;
        } else {
            graph = this.graph;
        }
        const pattern = new RegExp(url);
        const vector = graph.vectors.find((vec: Vector) => {
            return pattern.test(vec.url);
        }) as Vector;
        if (!vector && url) {
            this.logger.warn("Scheduler: Cannot find URL " + url);
            this.dispatchEvent("warning", {
                url,
                time: Date.now(),
                id: newId(),
                message: "Cannot find vector at the specified URL.",
            } as Warning);
        }
        if (vector) {
            this.logger.info("Executing vector at URL " + url);
            await execute(this, graph, vector, field, value);
        }
        this.dispatchEvent("end", {
            url,
            time: Date.now(),
            id: newId(),
            duration: Date.now() - start,
        } as SchedulerEvent);
        return {
            vectors: []
        };
    }
}
