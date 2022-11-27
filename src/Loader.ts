import Scheduler from "./Scheduler";
import {newId, EdgeError, LoadEvent} from "./Shared";
/**
 * Loads linked resources.  By default uses the global fetch function if any.
 * This behavior can be overridden by adding an event listener to
 * the load event and calling 'setValue' with the Node or Graph
 * requested.
 */
export default class Loader<T> {
    cache: {
        [key: string]: T;
    };
    scheduler: Scheduler;
    constructor(scheduler: Scheduler) {
        this.scheduler = scheduler;
        this.cache = {};
    }
    clearCache(): void {
        Object.keys(this.cache).forEach((key) => {
            delete this.cache[key];
        });
    }
    async load(url: string): Promise<T> {
        this.scheduler.logger.debug("Loader: loading: " + url);
        const ev = {
            time: Date.now(),
            id: newId(),
            url,
            setValue: (val: T) => {
                this.scheduler.logger.debug("Loader: loading resource via load event: " + url);
                this.cache[url] = val;
            }
        } as LoadEvent;
        this.scheduler.dispatchEvent("load", ev);
        if (this.cache[url]) {
            this.scheduler.logger.debug("Loader: cache hit: " + url);
            return this.cache[url];
        }
        this.scheduler.logger.debug("Loader: cache miss: " + url);
        if (typeof fetch === "undefined") {
            const er = new Error("Fetch is not defined.  For URLs to be " +
                "fetched you must define a global fetch method that complies " +
                "with https://fetch.spec.whatwg.org/.");
            this.scheduler.logger.error(er.stack);
            this.scheduler.dispatchEvent("error", {
                id: newId(),
                time: Date.now(),
                err: er,
                url,
                message: er.toString(),
            } as EdgeError);
            throw er;
        }
        this.scheduler.logger.debug("Loader: loading resource via fetch: " + url);
        const data = await fetch(url);
        this.cache[url] = await data.json();
        return this.cache[url];
    }
}
