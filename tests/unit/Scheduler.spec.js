/* global describe it expect jest beforeEach require global setTimeout */
const fetchMock = require("../mocks/fetch.js"); // eslint-disable-line
const Scheduler = require("../../dist/index.js").default;
const stubs = {};
function linkStubs() { // eslint-disable-line
    ["emptyGraph", "singleLogVector", "proxyToLog", "linkedGraph", "linkedCycleInner",
        "linkedCycleOuter", "linkedLogVector", "proxyToLog", "publishedLogVector",
        "badVectorConnector", "badVectorSet", "emptyVectorSet", "malformedSchema",
        "malformedSchemaSubGraphMap", "mathCosVector", "cacheLinkedGraph"].forEach((key) => {
        stubs[key] = JSON.parse(JSON.stringify(require("../stubs/"+ key + ".json"))); // eslint-disable-line
    });
    global.fetch = undefined;
    stubs.console = {
        log: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
    }
}
function getTestValue() { // eslint-disable-line
    return "___" + Date.now();
}
describe("Basic scheduler functions", () => {
    beforeEach(linkStubs);
    it("Load an empty graph, no navigraion.", (done) => {
        const scheduler = new Scheduler(stubs.emptyGraph);
        expect(scheduler).toBeInstanceOf(Scheduler);
        return done();
    });
    it("Should load a graph that has a single vector that executes when navigated to", (done) => {
        const scheduler = new Scheduler(stubs.singleLogVector);
        const testVal = getTestValue();
        global.console.info = jest.fn();
        scheduler.url("index", testVal);
        expect(global.console.info).toHaveBeenCalledWith(testVal);
        return done();
    });
    it("Should load a graph that has a two vectors.  One that proxies a message to a log vector", (done) => {
        const scheduler = new Scheduler(stubs.proxyToLog);
        const testVal = getTestValue();
        global.console.info = jest.fn();
        scheduler.url("index", testVal);
        expect(global.console.info).toHaveBeenCalledWith(testVal);
        return done();
    });
});
describe("Scheduler graph linking input and output connectors", () => {
    beforeEach(linkStubs);
    it("Should load a graph that has a linked graph vector that links a proxy log graph", (done) => {
        const scheduler = new Scheduler(stubs.linkedGraph);
        global.fetch = fetchMock(() => {
            return stubs.proxyToLog;
        });
        const testVal = getTestValue();
        global.console.info = jest.fn();
        scheduler.url("index", testVal);
        setTimeout(() => {
            expect(global.console.info).toHaveBeenCalledWith(testVal);
            return done();
        });
    });
    it("Should load a graph that has a linked graph vector that links a proxy log graph, call a second time, and expect to only have fetch called once proving the cache works.", (done) => {
        const scheduler = new Scheduler(stubs.linkedGraph);
        let fetchCount = 0;
        global.fetch = fetchMock(() => {
            fetchCount += 1;
            return stubs.proxyToLog;
        });
        const testVal = getTestValue();
        global.console.info = jest.fn();
        scheduler.url("index", testVal);
        setTimeout(() => {
            scheduler.url("index", testVal);
            setTimeout(() => {
                expect(fetchCount).toEqual(1);
                return done();
            });
        });
    });
    it("Should load a graph that has a linked graph vector that links a proxy log graph, call a second time, and expect to only have fetch called once proving the cache works.", (done) => {
        const scheduler = new Scheduler(stubs.cacheLinkedGraph, {}, {});
        let fetchCount = 0;
        global.fetch = fetchMock(() => {
            fetchCount += 1;
            return stubs.proxyToLog;
        });
        global.console.info = jest.fn();
        scheduler.url("index");
        setTimeout(() => {
            scheduler.graphLoader.clearCache();
            scheduler.url("index");
            setTimeout(() => {
                expect(fetchCount).toEqual(2);
                return done();
            });
        });
    });
    it("Should load a graph that has a linked graph vector that links a proxy that then links to an output vector that links to a log vector on the input graph", (done) => {
        const scheduler = new Scheduler(stubs.linkedCycleOuter);
        global.fetch = fetchMock((path) => {
            if (/inner/.test(path)) {
                return stubs.linkedCycleInner;
            }
            return stubs.linkedCycleOuter;
        });
        const testVal = getTestValue();
        global.console.info = jest.fn();
        scheduler.url("index", testVal);
        setTimeout(() => {
            expect(global.console.info).toHaveBeenCalledWith(testVal);
            return done();
        });
    });
    it("Should load a graph that has a linked graph vector that links a proxy log graph and override the inner graph data with another value", (done) => {
        const scheduler = new Scheduler(stubs.linkedGraph);
        global.fetch = fetchMock(() => {
            return stubs.proxyToLog;
        });
        scheduler.url("index");
        global.console.warn = jest.fn();
        setTimeout(() => {
            // test is hard coded into the graph
            expect(global.console.warn).toHaveBeenCalledWith("TEST");
            return done();
        });
    });
});
describe("Scheduler vector linking", () => {
    beforeEach(linkStubs);
    it("Should load a graph that has a linked log vector", (done) => {
        const scheduler = new Scheduler(stubs.linkedLogVector);
        global.fetch = fetchMock(() => {
            return stubs.publishedLogVector;
        });
        const testVal = getTestValue();
        global.console.info = jest.fn();
        scheduler.url("index", testVal);
        setTimeout(() => {
            expect(global.console.info).toHaveBeenCalledWith(testVal);
            return done();
        });
    });
});
describe("Scheduler event emitter and scheduler sequence validation", () => {
    beforeEach(linkStubs);
    it("Should emit a begin event when the url method is called.", (done) => {
        const scheduler = new Scheduler(stubs.linkedLogVector);
        scheduler.addEventListener("begin", () => {
            return done();
        });
        scheduler.url("index");
    });
    it("Should load a graph via the event emitter's load method.", (done) => {
        const scheduler = new Scheduler(stubs.linkedLogVector, {}, {}, stubs.console);
        scheduler.addEventListener("load", (e) => {
            expect(e.url).toEqual("artifacts/vectors/1234.0");
            e.setValue(stubs.publishedLogVector);
        });
        scheduler.url("index");
        setTimeout(() => {
            expect(stubs.console.error).toHaveBeenCalledTimes(0);
            done();
        });
    });
    it("Should emit an end event after the begin event when the url method is called.", (done) => {
        const scheduler = new Scheduler(stubs.linkedLogVector);
        const seq = [];
        scheduler.addEventListener("begin", () => {
            seq.push("begin");
        });
        scheduler.addEventListener("end", () => {
            seq.push("end");
            expect(seq.join(",")).toEqual("begin,end");
            return done();
        });
        scheduler.url("index");
    });
    it("Should be able to remove event listeners.", (done) => {
        const scheduler = new Scheduler(stubs.linkedLogVector);
        const seq = [];
        function begin() { // eslint-disable-line
            seq.push("begin");
        }
        scheduler.addEventListener("begin", begin);
        scheduler.removeEventListener("begin", begin);
        scheduler.addEventListener("end", () => {
            seq.push("end");
            expect(seq.join(",")).toEqual("end");
            return done();
        });
        scheduler.url("index");
    });
    it("Should be able to remove from events that do not exist without throwing an error.", (done) => {
        const scheduler = new Scheduler(stubs.singleLogVector);
        const seq = [];
        function begin() { // eslint-disable-line
            seq.push("begin");
        }
        scheduler.removeEventListener("blah", begin);
        scheduler.addEventListener("end", () => {
            seq.push("end");
            expect(seq.join(",")).toEqual("end");
            return done();
        });
        scheduler.url("index");
    });
    it("Should be able to remove event listeners that are not bound without throwing an error.", (done) => {
        const scheduler = new Scheduler(stubs.singleLogVector);
        const seq = [];
        function begin() { // eslint-disable-line
            seq.push("begin");
        }
        // note: this must be added initally then removed twice
        // to get the this.events object to pass the first check
        scheduler.addEventListener("begin", begin);
        scheduler.removeEventListener("begin", begin);
        scheduler.removeEventListener("begin", begin);
        scheduler.addEventListener("end", () => {
            seq.push("end");
            expect(seq.join(",")).toEqual("end");
            return done();
        });
        scheduler.url("index");
    });
    it("Should emit a warning event when there is no URL match.", (done) => {
        const scheduler = new Scheduler(stubs.linkedLogVector);
        scheduler.addEventListener("warning", (e) => {
           expect(e.message).toEqual("Cannot find vector at the specified URL.");
           return done();
        });
        scheduler.url("not-here");
    });
    it("Should emit a begin, beginedge, end, then endedge.", (done) => {
        const scheduler = new Scheduler(stubs.linkedLogVector);
        const seq = [];
        scheduler.addEventListener("begin", () => {
            seq.push("begin");
        });
        scheduler.addEventListener("beginedge", () => {
            seq.push("beginedge");
        });
        scheduler.addEventListener("endedge", () => {
            seq.push("endedge");
            expect(seq.join(",")).toEqual("begin,beginedge,end,endedge");
            return done();
        });
        scheduler.addEventListener("end", () => {
            seq.push("end");
        });
        scheduler.url("index");
    });
    it("Should emit a begin, beginedge, end, set, then endedge.  Return data should be -0.8390715290764524 (Math.cos(10))", (done) => {
        const scheduler = new Scheduler(stubs.mathCosVector);
        const seq = [];
        scheduler.addEventListener("begin", () => {
            seq.push("begin");
        });
        scheduler.addEventListener("beginedge", () => {
            seq.push("beginedge");
        });
        scheduler.addEventListener("set", (e) => {
            seq.push("set");
            seq.push(e.return);
        });
        scheduler.addEventListener("endedge", () => {
            seq.push("endedge");
            expect(seq.join(",")).toEqual("begin,beginedge,end,set,-0.8390715290764524,endedge");
            return done();
        });
        scheduler.addEventListener("end", () => {
            seq.push("end");
        });
        scheduler.url("index", 10);
    });
});
describe("Scheduler error states and matching error events", () => {
    beforeEach(linkStubs);
    it("Should throw an error if you try and load the scheduler without a graph.", (done) => {
        try {
            new Scheduler();
        } catch (err) {
            expect(err.toString()).toMatch(/No graph was passed to the scheduler constructor/);
        }
        return done();
    });
    it("Should throw an error if a fetch is attempted but fetch is not defined", (done) => {
        const scheduler = new Scheduler(stubs.linkedLogVector, {}, {}, stubs.console);
        const evs = [];
        global.fetch = undefined;
        scheduler.addEventListener("error", (e) => {
            evs.push(e);
        });
        scheduler.url("index");
        setTimeout(() => {
            const match = "Error: Fetch is not defined.  For URLs to be fetched you must define a global fetch method that complies with https://fetch.spec.whatwg.org/.";
            expect(stubs.console.error.mock.calls[0][0]).toMatch(match);
            expect(evs[0].message).toMatch(match);
            return done();
        });
    });
    it("Should log an error if the remote vector is undefined", (done) => {
        const scheduler = new Scheduler(stubs.linkedLogVector, {}, {}, stubs.console);
        global.fetch = fetchMock(() => {
            return;
        });
        const evs = [];
        scheduler.addEventListener("error", (e) => {
            evs.push(e);
        });
        scheduler.url("index");
        setTimeout(() => {
            const match = "Error: Vector: Critical Error: Linked vector not found on vector.id: 1";
            expect(stubs.console.error.mock.calls[0][0]).toMatch(match);
            expect(evs[0].message).toMatch(match);
            return done();
        });
    });
    it("Should log an error if the remote graph is undefined", (done) => {
        const scheduler = new Scheduler(stubs.linkedGraph, {}, {}, stubs.console);
        global.fetch = fetchMock(() => {
            return;
        });
        const evs = [];
        scheduler.addEventListener("error", (e) => {
            evs.push(e);
        });
        scheduler.url("index");
        setTimeout(() => {
            const match = "Error: Vector: Critical Error: Linked graph not found on vector.id: 2";
            expect(stubs.console.error.mock.calls[0][0]).toMatch(match);
            expect(evs[0].message).toMatch(match);
            return done();
        });
    });
    it("Should log an error if a connector refers to a vector that does not exist", (done) => {
        const scheduler = new Scheduler(stubs.badVectorConnector, {}, {}, stubs.console);
        const evs = [];
        scheduler.addEventListener("error", (e) => {
            evs.push(e);
        });
        scheduler.url("index");
        setTimeout(() => {
            const match = "Error: Connector refers to a vector edge that does not exist.  Connector.id: 0";
            expect(stubs.console.error.mock.calls[0][0]).toMatch(match);
            expect(evs[0].message).toMatch(match);
            return done();
        });
    });
    it("Should log an error if a set template is empty", (done) => {
        const scheduler = new Scheduler(stubs.emptyVectorSet, {}, {}, stubs.console);
        const evs = [];
        scheduler.addEventListener("error", (e) => {
            evs.push(e);
        });
        scheduler.url("index");
        setTimeout(() => {
            const match = "Error: Vector: No template for set found on vector.id 1";
            expect(stubs.console.error.mock.calls[0][0]).toMatch(match);
            expect(evs[0].message).toMatch(match);
            return done();
        });
    });
    it("Should log an error if a set template causes an error", (done) => {
        const scheduler = new Scheduler(stubs.badVectorSet, {}, {}, stubs.console);
        const evs = [];
        scheduler.addEventListener("set", (e) => {
            evs.push(e.err.toString());
        });
        scheduler.url("index");
        setTimeout(() => {
            const match = "Vector: set function caused an error: ReferenceError: x is not defined";
            expect(stubs.console.error.mock.calls[0][0]).toMatch(match);
            return done();
        });
    });
    it("Should log an error if scheduler encouters a malformed schema at setter time", (done) => {
        const scheduler = new Scheduler(stubs.malformedSchema, {}, {}, stubs.console);
        const evs = [];
        scheduler.addEventListener("error", (e) => {
            evs.push(e);
        });
        scheduler.url("index");
        setTimeout(() => {
            const match = "Error: Vector: Edge setter error. field proxy, vector.id 1: TypeError: Cannot read property 'length' of undefined";
            expect(stubs.console.error.mock.calls[0][0]).toMatch(match);
            expect(evs[0].message).toMatch(match);
            return done();
        });
    });
    it("Should log an error if scheduler encouters a malformed linked graph map", (done) => {
        const scheduler = new Scheduler(stubs.malformedSchemaSubGraphMap, {}, {}, stubs.console);
        global.fetch = fetchMock(() => {
            return stubs.proxyToLog;
        });
        const evs = [];
        scheduler.addEventListener("error", (e) => {
            evs.push(e);
        });
        scheduler.url("index");
        setTimeout(() => {
            const match = "Edge: Error occured during vector.execute: TypeError: Cannot read property 'field' of undefined";
            expect(stubs.console.error.mock.calls[0][0]).toMatch(match);
            expect(evs[0].message).toMatch(match);
            return done();
        });
    });
});
