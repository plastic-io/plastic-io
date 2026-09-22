import Node from "./Node";
import {execute} from "./Edge";
import {ConnectorEvent, LoadEvent, Graph, newId, Logger, nullLogger,
    SchedulerEvent, ExecutionResult, Warning, EdgeError, NodeSetEvent, SchedulerOptions} from "./Shared";
import Loader from "./Loader";
import type {GraphInstance} from "./Instances";
import {pristine} from "./Instances";
import {Execution, ExecutionHandle, BudgetSpec} from "./Execution";
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
 * See the {@link default.constructor} for more information on instantiation.  After you instantiate
 * the scheduler, you can call {@link default.url} to directly invoke a node's edge (set function).
 *
 * ## Graph
 * {@link Graph}s contain arrays of {@link Node}s.  Nodes are executable units of code and can be local to the graph, or reference other nodes or graphs.
 *
 * # Scheduler Execution Digram
 *
 *                   1                         2                            3
 *             +-------------+         +---------------+         +--------------------+
 *             |             |         |               |         |                    |
 *             |  Scheduler  |         |  Node Edge    |         |   Edge Connector   |
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
 *  1. Scheduler.url() calls a node's edge (set function) based on the node.url.
 *  2. Node Edge calls `edges[field]` which invokes n connectors referencing other node edges
 *  3. Node edge is invoked just like step one, creating a graph loop.
 *
 *
 *
 *
 */
export default class Scheduler {
    /**
     * Occurs when the graph begins to navigate to a node's URL via the {@link default.url} function.
     * @event
     */
    begin: (e: SchedulerEvent) => void;
    /**
     * Occurs when a connector value enters into a node's edge (input).
     * @event
     */
    beginedge: (e: SchedulerEvent) => void;
    /**
     * Occurs after all all edge promises are completed.  Note: If your nodes do not return promises.
     * @event
     */
    endedge: (e: SchedulerEvent) => void;
    /**
     * Occurs when an error occurred during the invocation of a node.
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
     * Occurs when an execution has ended: every promise it started has settled, or its budget ran out, or it was cancelled (2.1).
     * Carries `executionId`, `state`, `reason`, `hops` and `errors`.
     * @event
     */
    end: (e: SchedulerEvent) => void;
    /**
     * Occurs when `host.emit(kind, data)` is called from node code (2.1).
     * @event
     */
    observation: (e: SchedulerEvent) => void;
    /**
     * Occurs when an execution is asked to stop, by the caller or by its budget (2.1).
     * @event
     */
    cancel: (e: SchedulerEvent) => void;
    /**
     * Occurs just before set is called.  You can use `setContext` to alter the `this` context object of the node just before the node's set function is invoked.
     * @event
     */
    set: (e: NodeSetEvent) => void;
    /**
     * Occurs as a node's set function has called `edges[field] = <value>;`.
     * @event
     */
    beginconnector: (e: ConnectorEvent) => void;
    /**
     * Occurs when a connector promise chain has completed after a node's set function has called `edges[field] = <value>;`.
     * @event
     */
    endconnector: (e: ConnectorEvent) => void;
    /**
     * Occurs after a node's set function has completed.  Contains the return value of the function.  Although this return value is present, using it is considered an anti-pattern and is only included for debugging.
     * @event
     */
    afterSet: (e: NodeSetEvent) => void;
    /** The base graph */
    graph: Graph;
    /** Logging functions */
    logger: Logger;
    /** Loader for loading graphs */
    graphLoader: Loader<Graph>;
    /** Loader for loading nodes */
    nodeLoader: Loader<Node>;
    /** Event sequence counter: every dispatched event carries the next value as `seq` (2.1) */
    sequence: number;
    /** Scheduler-wide settings (2.1) */
    options: SchedulerOptions;
    /** Executions that have not ended yet, by id (2.1) */
    executions: {
        [key: string]: Execution;
    };
    /** Compiled set functions by source text, so a node is compiled once per scheduler (2.1) */
    compiled: {
        [key: string]: Function; // tslint:disable-line
    };
    /** The domain specific context object.  User defined and used by set methods. */
    context: object;
    /** Mutable state object.  This object can be changed and examined later. */
    state: object;
    /** Node specific runtime cache object.  Used in set functions for any reason the author sees fit. */
    nodeCache: {
        [key: string]: {};
    };
    /**
     * Live copies of linked graphs, by the path of host nodes they were
     * reached through (2.3).  A linked graph is instantiated when a value
     * arrives at it, so the same use keeps its nodes and their data between
     * calls, two uses share nothing, and a graph reached through itself is a
     * deeper path — which is what makes recursion possible.
     */
    instances: {
        [key: string]: GraphInstance;
    };
    /**
     * Each document as it was before anything ran, kept against the object it
     * came from (2.3).  An instance is a copy of the *document*, not of
     * whatever the running graph has become — a recursive call must not start
     * life holding what its caller was in the middle of.  Keyed by identity
     * rather than by id, because two graphs may honestly share an id and
     * version while being different documents.
     */
    documents: WeakMap<Graph, Graph>;
    /** The parameterized path to linked graph documents */
    graphPath: string;
    /** The parameterized path to linked node documents */
    nodePath: string;
    /** Holds events in the event bus */
    events: {
        [key: string]: Function[]; // tslint:disable-line
    };
    /**
     * @param graph Graph to execute.
     * @param context What will appear as the `this` object for any node set function that executes on your graph.
     * @param state Object that will be available to node set functions during graph execution.  You can alter this object before or after instantiating the scheduler.  See {@link NodeInterface}.
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
     * You can also execute the graph and pass context variables to the nodes.
     * In the example below, nodes executing on myGraph will have access to `{foo: "bar"}` by accessing `this.foo` at runtime.
     * This allows you to attach properties like server response functions, database connections, client side component references, and many other things
     * use full to the node's set function on runtime.
     *   ```TypeScript
     *   const scheduler = new Scheduler(myGraphJSON, {foo: "bar"});
     *   ```
     *
     * ### With State Defined
     * Nodes now have a mutable object with which they can share long running objects, data caches
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
    constructor(graph: Graph, context: object = {}, state: object = {}, logger: Logger = nullLogger, options: SchedulerOptions = {}) {
        logger.debug("Scheduler started");
        if (!graph) {
            throw new Error("No graph was passed to the scheduler constructor.");
        }
        // the following empty methods are here for documentation of events only
        this.begin = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.beginedge = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.endedge = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.error = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.load = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.begin = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.warning = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.end = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.set = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.beginconnector = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.endconnector = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.afterSet = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.observation = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.cancel = (e: SchedulerEvent): void => { e;return; }; // tslint:disable-line
        this.graph = graph;
        this.options = options || {};
        this.executions = {};
        this.compiled = {};
        this.sequence = 0;
        this.context = context;
        this.state = state;
        this.events = {};
        this.nodeCache = {};
        this.instances = {};
        this.documents = new WeakMap();
        this.documents.set(graph, pristine(graph));
        this.graphPath = "artifacts/graph/{id}.{version}";
        this.nodePath = "artifacts/nodes/{id}.{version}";
        this.logger = logger;
        this.graphLoader = new Loader<Graph>(this);
        this.nodeLoader = new Loader<Node>(this);
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
    addEventListener(eventName: string, listener: (eventData: ConnectorEvent| SchedulerEvent | LoadEvent | EdgeError | NodeSetEvent | Error | Warning) => void): void {
        this.logger.debug("Scheduler: Add event " + eventName);
        this.events[eventName] = this.events[eventName] || [];
        this.events[eventName].push(listener);
    }
    /** Dispatches an event.  Every event is stamped with the next `seq` (2.1). */
    dispatchEvent(eventName: string, eventData: SchedulerEvent): void {
        this.logger.debug("Scheduler: Dispatch event " + eventName);
        if (eventData && typeof eventData === "object" && eventData.seq === undefined) {
            this.sequence += 1;
            eventData.seq = this.sequence;
        }
        if (this.events[eventName]) {
            for (const listener of this.events[eventName]) {
                listener.call(this, eventData);
            }
        }
    }
    getNodePath(id: string, version: number): string {
        return this.nodePath.replace("{id}", id).replace("{version}", version.toString());
    }
    getGraphPath(id: string, version: number): string {
        return this.graphPath.replace("{id}", id).replace("{version}", version.toString());
    }
    /**
     *
     *    ### Simple Node Edge Invocation
     *
     * Invoke a Node's Edge (set function).
     *
     *   ```TypeScript
     *   const scheduler = new Scheduler(myGraphJSON);
     *   scheduler.url("my-graph-url");
     *   ```
     *
     *    ### Invoke Edge with Value
     *
     * Invoke a Node's Edge (set function), and send a value to the edge.
     *
     *   ```TypeScript
     *   const scheduler = new Scheduler(myGraphJSON);
     *   scheduler.url("my-graph-url", "some value");
     *   ```
     *
     *    ### Invoke Edge with Value, and Field
     *
     * Invoke a Node's Edge (set function), and send a value to the edge.
     *
     *   ```TypeScript
     *   const scheduler = new Scheduler(myGraphJSON);
     *   scheduler.url("my-graph-url", "some value", "some_field");
     *   ```
     *
     *    ### Advanced: Pass Previous Execution Context
     *
     * By passing a node instance, you can invoke nodes embedded in inner graphs.
     *
     *   ```TypeScript
     *   const scheduler = new Scheduler(myGraphJSON);
     *   scheduler.url("my-graph-url", "some value", "some_field", myInnerNodeInstance);
     */
    async url(url: string, value?: any, field?: string, currentNode?: Node): Promise<ExecutionResult> {
        return this.invoke(url, value, field, currentNode).done;
    }
    /**
     * Invoke a node's edge and get a handle on the execution (2.1).
     *
     * The handle's `done` promise settles when every promise the execution
     * started has settled, when its budget runs out, or when `cancel()` is
     * called; `url()` is `invoke(...).done`.
     *
     *   ```TypeScript
     *   const handle = scheduler.invoke("my-graph-url", value, "field", undefined, {budget: {wallMs: 5000, hops: 1000}});
     *   const result = await handle.done;   // {state: "completed" | "failed" | "cancelled" | "abandoned", hops, errors, ...}
     *   ```
     */
    invoke(url: string, value?: any, field?: string, currentNode?: Node, options: {budget?: BudgetSpec; executionId?: string; revisionId?: string} = {}): ExecutionHandle {
        this.logger.debug("Scheduler: Set URL " + url);
        const execution = new Execution(this, {
            url,
            budget: {...(this.options.budget || {}), ...(options.budget || {})},
            executionId: options.executionId,
            revisionId: options.revisionId,
        });
        this.executions[execution.executionId] = execution;
        execution.start();
        this.dispatchEvent("begin", {
            url,
            time: execution.startedAt,
            id: newId(),
            executionId: execution.executionId,
        } as SchedulerEvent);
        let graph;
        if (currentNode && currentNode.linkedGraph && currentNode.linkedGraph.graph) {
            graph = currentNode.linkedGraph.graph;
        } else {
            graph = this.graph;
        }
        const pattern = new RegExp(url);
        const node = graph.nodes.find((vec: Node) => {
            return pattern.test(vec.url);
        }) as Node;
        if (!node && url) {
            this.logger.warn("Scheduler: Cannot find URL " + url);
            this.dispatchEvent("warning", {
                url,
                time: Date.now(),
                id: newId(),
                message: "Cannot find node at the specified URL.",
                executionId: execution.executionId,
            } as Warning);
        }
        if (node) {
            this.logger.info("Executing node at URL " + url);
            const span = execution.span();
            execution.track(execute(this, graph, node, field as string, value, span).catch((err) => {
                execution.rootFailed = true;
                this.dispatchEvent("error", {
                    time: Date.now(),
                    id: newId(),
                    err,
                    executionId: execution.executionId,
                    spanId: span.spanId,
                } as EdgeError);
            }));
        }
        execution.arm();
        return execution;
    }
    /**
     * Start a new execution for work that begins on its own, such as a node
     * emitting on an edge long after the execution that created it has ended
     * (a UI node reacting to a click, a timer).  Used internally.
     */
    beginExecution(url: string, parentExecutionId?: string): Execution {
        const execution = new Execution(this, {url, budget: this.options.budget, parentExecutionId});
        this.executions[execution.executionId] = execution;
        execution.start();
        this.dispatchEvent("begin", {
            url,
            time: execution.startedAt,
            id: newId(),
            executionId: execution.executionId,
            parentExecutionId,
            trigger: "edge",
        } as SchedulerEvent);
        return execution;
    }
    /** Cancel every execution that has not ended (2.1). */
    cancelAll(reason: string = "cancelled"): Promise<void> {
        const pending = Object.keys(this.executions).map((id) => this.executions[id].cancel(reason));
        return Promise.all(pending).then(() => { return; });
    }
    /** An execution has ended.  Used internally. */
    forget(execution: Execution): void {
        delete this.executions[execution.executionId];
    }
}
