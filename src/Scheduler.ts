import Vector from "./Vector";
import {execute} from "./Edge";
import {Graph, newId, Logger, nullLogger, SchedulerEvent, ExecutionResult, Warning} from "./Shared";
import Loader from "./Loader";
/** Graph execution engine */
export default class Scheduler {
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
        [key: string]: Function[];
    };
    /** Plastic-io graph scheduler runtime. */
    constructor(graph: Graph, context: object = {}, state: object = {}, logger: Logger = nullLogger) {
        logger.debug("Scheduler started");
        if (!graph) {
            throw new Error("No graph was passed to the scheduler constructor.");
        }
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
    removeEventListener(eventName: string, listener: Function): void {
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
    addEventListener(eventName: string, listener: Function): void {
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
    /** Navigate to a given vector via vector URL */
    async url(url: string, value: any): Promise<ExecutionResult> {
        this.logger.debug("Scheduler: Set URL " + url);
        const start = Date.now();
        this.dispatchEvent("begin", {
            time: start,
            id: newId(),
        } as SchedulerEvent);
        const pattern = new RegExp(url);
        const vector = this.graph.vectors.find((vector: Vector) => {
            return pattern.test(vector.url);
        }) as Vector;
        if (!vector && url) {
            this.logger.warn("Scheduler: Cannot find URL " + url);
            this.dispatchEvent("warning", {
                time: Date.now(),
                id: newId(),
                message: "Cannot find vector at the specified URL.",
            } as Warning);
        }
        if (vector) {
            this.logger.info("Executing vector at URL " + url);
            await execute(this, this.graph, vector, "$url", value);
        }
        this.dispatchEvent("end", {
            time: Date.now(),
            id: newId(),
            duration: Date.now() - start,
        } as SchedulerEvent);
        return {
            vectors: []
        };
    }
}