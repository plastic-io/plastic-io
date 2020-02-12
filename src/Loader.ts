import Scheduler from "./Scheduler";
import {newId, EdgeError, LoadEvent} from "./Shared";
/** Loads linked resources.  By default uses the global fetch function if any.
This behavior can be overridden by adding an event listener to
the load even and calling 'setValue' with the Vector or Graph
requested. */
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
        const scheduler = this.scheduler;
        const cache = this.cache
        ;
        scheduler.logger.debug("Loader: loading: " + url);
        const ev = {
            time: Date.now(),
            id: newId(),
            setValue(val: T) {
                scheduler.logger.debug("Loader: loading resource via load event: " + url);
                cache[url] = val;
            }
        } as LoadEvent;
        scheduler.dispatchEvent("load", ev);
        if (cache[url]) {
            scheduler.logger.debug("Loader: cache hit: " + url);
            return cache[url];
        }
        scheduler.logger.debug("Loader: cache miss: " + url);
        if (typeof fetch === "undefined") {
            const er = new Error("Fetch is not defined.  For URLs to be " +
                "fetched you must define a global fetch method that complies " +
                "with https://fetch.spec.whatwg.org/.");
            scheduler.logger.error(er.stack);
            scheduler.dispatchEvent("error", {
                id: newId(),
                time: Date.now(),
                err: er,
                message: er.toString(),
            } as EdgeError);
            throw er;
        }
        scheduler.logger.debug("Loader: loading resource via fetch: " + url);
        const data = await fetch(url);
        cache[url] = await data.json();
        return cache[url]
    }
}
