/* global describe it expect jest require setTimeout */
const fetchMock = require("../mocks/fetch.js"); // eslint-disable-line
const Scheduler = require("../../dist/index.js").default;

/**
 * Linked graphs as calls (2.3).
 *
 * The thing this library was always meant to reach: a graph that contains
 * another — including itself — where each use is its own, with its own nodes,
 * its own data and its own scratch. These prove the three claims: recursion
 * terminates and each turn is a level of its own; two uses of one subgraph
 * share nothing; and the same use keeps what it had between calls.
 */

const node = (id, set, over = {}) => ({
    id, url: over.url || id, version: 0, graphId: over.graphId || "root", data: over.data === undefined ? null : over.data,
    properties: over.properties || {}, template: {set}, edges: over.edges || [],
});
const edge = (field, connectors = []) => ({field, connectors});
const to = (nodeId, field, graphId = "root") => ({id: `c-${nodeId}-${field}-${Math.random().toString(36).slice(2, 7)}`, nodeId, field, graphId, version: 0});
const graph = (id, nodes) => ({id, url: id, version: 0, nodes, properties: {name: id, description: ""}});

/**
 * A graph that contains itself: `step` counts down and hands the rest of the
 * work to `self`, which is this same graph again.
 */
function countdown(setBody) {
    const g = graph("countdown", [
        node("step", setBody, {url: "step", graphId: "countdown", edges: [edge("deeper", [to("self", "in", "countdown")])]}),
        node("self", "", {url: "self", graphId: "countdown", edges: [edge("out", [])]}),
    ]);
    g.nodes[1].linkedGraph = {
        id: "countdown", version: 0, loaded: false, graph: g, properties: {}, data: {},
        fields: {inputs: {in: {id: "step", field: "in"}}, outputs: {}},
    };
    return g;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("a graph that contains itself", () => {
    it("runs one level at a time, each with its own instance, and stops when the graph stops it", async () => {
        const g = countdown(`
            state.trace = state.trace || [];
            state.trace.push({n: value.n, depth: instance ? instance.depth : 0, path: instance ? instance.path.join("/") : ""});
            if (value.n > 0) { edges.deeper = {n: value.n - 1}; }
        `);
        const state = {};
        const scheduler = new Scheduler(g, {}, state);
        await scheduler.url("step", {n: 3});
        await settle();
        expect(state.trace.map((t) => t.n)).toEqual([3, 2, 1, 0]);
        // each turn is a level of its own, named by the hosts it came through
        expect(state.trace.map((t) => t.depth)).toEqual([0, 1, 2, 3]);
        expect(state.trace.map((t) => t.path)).toEqual(["", "self", "self/self", "self/self/self"]);
        // and the scheduler kept one instance per level, not one for the graph
        expect(Object.keys(scheduler.instances).sort()).toEqual(["self", "self/self", "self/self/self"]);
    });

    it("gives every turn its own scratch, while the graph's state stays the graph's", async () => {
        const g = countdown(`
            instance && (instance.state.visits = (instance.state.visits || 0) + 1);
            state.visits = (state.visits || 0) + 1;
            state.perInstance = state.perInstance || [];
            state.perInstance.push(instance ? instance.state.visits : null);
            if (value.n > 0) { edges.deeper = {n: value.n - 1}; }
        `);
        const state = {};
        const scheduler = new Scheduler(g, {}, state);
        await scheduler.url("step", {n: 3});
        await settle();
        // the graph counted every visit; each instance counted only its own
        expect(state.visits).toBe(4);
        expect(state.perInstance).toEqual([null, 1, 1, 1]);
    });

    it("gives every turn its own data, so a node inside one level cannot see another's", async () => {
        const g = countdown(`
            data = data || {seen: []};
            data.seen.push(value.n);
            state.data = state.data || [];
            state.data.push(JSON.stringify(data.seen));
            node.data = data;
            if (value.n > 0) { edges.deeper = {n: value.n - 1}; }
        `);
        const state = {};
        const scheduler = new Scheduler(g, {}, state);
        await scheduler.url("step", {n: 2});
        await settle();
        expect(state.data).toEqual(["[2]", "[1]", "[0]"]);
    });

    it("stops a recursion that does not stop itself, naming the path it took", async () => {
        const g = countdown("edges.deeper = {n: value.n + 1};");   // no base case
        const errors = [];
        const scheduler = new Scheduler(g, {}, {}, undefined, {linkedGraphDepth: 4});
        scheduler.addEventListener("error", (e) => errors.push(e));
        await scheduler.url("step", {n: 0});
        await settle();
        expect(errors.length).toBeGreaterThan(0);
        const message = errors.map((e) => e.message).join(" ");
        expect(message).toContain("Linked graphs went 5 deep (limit 4)");
        expect(message).toContain("self → self → self → self → self");
        // it stopped where it said it did
        expect(Object.keys(scheduler.instances)).toHaveLength(4);
    });
});

describe("two uses of one subgraph", () => {
    const shared = () => graph("shared", [
        node("inner", `
            data = data || {calls: 0};
            data.calls += 1;
            node.data = data;
            state.calls = state.calls || [];
            state.calls.push({who: instance ? instance.path.join("/") : "root", calls: data.calls, mine: (instance.state.mine = (instance.state.mine || 0) + 1)});
        `, {url: "inner", graphId: "shared", edges: []}),
    ]);

    const withTwoUses = () => {
        const inner = shared();
        const g = graph("root", [
            node("entry", "edges.left = value; edges.right = value;", {
                edges: [edge("left", [to("first", "in")]), edge("right", [to("second", "in")])],
            }),
            node("first", "", {edges: []}),
            node("second", "", {edges: []}),
        ]);
        [1, 2].forEach((i) => {
            g.nodes[i].linkedGraph = {
                id: "shared", version: 0, loaded: false, graph: inner, properties: {},
                data: {inner: {calls: 0, label: i === 1 ? "first" : "second"}},
                fields: {inputs: {in: {id: "inner", field: "in"}}, outputs: {}},
            };
        });
        return g;
    };

    it("share nothing: not their nodes, not their data, not their scratch", async () => {
        const state = {};
        const scheduler = new Scheduler(withTwoUses(), {}, state);
        await scheduler.url("entry", {});
        await settle();
        expect(state.calls).toHaveLength(2);
        expect(state.calls.map((c) => c.who).sort()).toEqual(["first", "second"]);
        // each counted one call of its own, not two of a shared node
        expect(state.calls.every((c) => c.calls === 1 && c.mine === 1)).toBe(true);
        expect(Object.keys(scheduler.instances).sort()).toEqual(["first", "second"]);
    });

    it("the same use called twice is the same instance, and keeps what it had", async () => {
        const state = {};
        const scheduler = new Scheduler(withTwoUses(), {}, state);
        await scheduler.url("entry", {});
        await settle();
        await scheduler.url("entry", {});
        await settle();
        expect(state.calls).toHaveLength(4);
        const first = state.calls.filter((c) => c.who === "first");
        expect(first.map((c) => c.calls)).toEqual([1, 2]);        // its node's data survived
        expect(first.map((c) => c.mine)).toEqual([1, 2]);         // and so did its scratch
        expect(Object.keys(scheduler.instances).sort()).toEqual(["first", "second"]);
    });

    it("leaves the document it was given exactly as it found it", async () => {
        const g = withTwoUses();
        const before = JSON.stringify(g);
        const scheduler = new Scheduler(g, {}, {});
        await scheduler.url("entry", {});
        await settle();
        expect(JSON.stringify(g)).toBe(before);
    });
});

describe("loading at the moment of the call", () => {
    const remote = () => {
        const inner = graph("remote", [node("inner", "state.ran = (state.ran || 0) + 1;", {url: "inner", graphId: "remote", edges: []})]);
        const g = graph("root", [
            node("entry", "if (value.go) { edges.out = value; }", {edges: [edge("out", [to("host", "in")])]}),
            node("host", "", {edges: []}),
        ]);
        g.nodes[1].linkedGraph = {
            id: "remote", version: 0, loaded: false, properties: {}, data: {},
            fields: {inputs: {in: {id: "inner", field: "in"}}, outputs: {}},
        };
        return {g, inner};
    };

    it("asks for the graph when a value reaches the node, and not before", async () => {
        const {g, inner} = remote();
        const asked = [];
        global.fetch = fetchMock((path) => { asked.push(path); return inner; });
        const state = {};
        const scheduler = new Scheduler(g, {}, state);
        await scheduler.url("entry", {go: false});
        await settle();
        expect(asked).toEqual([]);                     // nothing reached the linked node
        await scheduler.url("entry", {go: true});
        await settle();
        expect(asked).toEqual(["artifacts/graph/remote.0"]);
        expect(state.ran).toBe(1);
    });

    it("asks once for the document however many instances are made of it", async () => {
        const {g, inner} = remote();
        const asked = [];
        global.fetch = fetchMock((path) => { asked.push(path); return inner; });
        const state = {};
        const scheduler = new Scheduler(g, {}, state);
        await scheduler.url("entry", {go: true});
        await settle();
        await scheduler.url("entry", {go: true});
        await settle();
        expect(asked).toHaveLength(1);
        expect(state.ran).toBe(2);
    });
});

describe("what a node inside a call knows about the call", () => {
    /**
     * The instance is the graph a node is running in, not a badge handed to
     * whichever node the call arrived at.  A node two connectors deep into a
     * called graph belongs to that call as much as the first one does.
     */
    const twoDeep = () => {
        const inner = graph("inner", [
            node("front", "edges.on = value;", {url: "front", graphId: "inner", edges: [edge("on", [to("back", "in", "inner")])]}),
            node("back", `
                instance && (instance.state.seen = (instance.state.seen || 0) + 1);
                state.inside = state.inside || [];
                state.inside.push({who: instance ? instance.path.join("/") : null, depth: instance ? instance.depth : 0, seen: instance ? instance.state.seen : null});
            `, {url: "back", graphId: "inner", edges: []}),
        ]);
        const g = graph("root", [
            node("entry", "edges.left = value; edges.right = value;", {
                edges: [edge("left", [to("first", "in")]), edge("right", [to("second", "in")])],
            }),
            node("first", "", {edges: []}),
            node("second", "", {edges: []}),
        ]);
        [1, 2].forEach((i) => {
            g.nodes[i].linkedGraph = {
                id: "inner", version: 0, loaded: false, graph: inner, properties: {}, data: {},
                fields: {inputs: {in: {id: "front", field: "in"}}, outputs: {}},
            };
        });
        return g;
    };

    it("a node two connectors in still belongs to the call it was reached through", async () => {
        const state = {};
        const scheduler = new Scheduler(twoDeep(), {}, state);
        await scheduler.url("entry", {});
        await settle();
        expect(state.inside.map((i) => i.who).sort()).toEqual(["first", "second"]);
        expect(state.inside.every((i) => i.depth === 1 && i.seen === 1)).toBe(true);
    });

    it("and the same use called twice keeps that instance's scratch", async () => {
        const state = {};
        const scheduler = new Scheduler(twoDeep(), {}, state);
        await scheduler.url("entry", {});
        await settle();
        await scheduler.url("entry", {});
        await settle();
        expect(state.inside.filter((i) => i.who === "first").map((i) => i.seen)).toEqual([1, 2]);
    });
});

describe("a resolver that has to go and get it", () => {
    /**
     * The `load` event is how an embedder answers "where is this graph?", and
     * an embedder that has to ask a server answers with a promise.  The loader
     * used to check its cache the moment the listener *started*, so every
     * asynchronous resolver lost the race and it fell through to fetching the
     * path as if it were a URL.
     */
    it("is waited for, rather than raced", async () => {
        const inner = graph("remote", [node("inner", "state.ran = (state.ran || 0) + 1;", {url: "inner", graphId: "remote", edges: []})]);
        const g = graph("root", [
            node("entry", "edges.out = value;", {edges: [edge("out", [to("host", "in")])]}),
            node("host", "", {edges: []}),
        ]);
        g.nodes[1].linkedGraph = {
            id: "remote", version: 0, loaded: false, properties: {}, data: {},
            fields: {inputs: {in: {id: "inner", field: "in"}}, outputs: {}},
        };
        global.fetch = () => { throw new Error("the loader should not have fetched anything"); };
        const state = {};
        const scheduler = new Scheduler(g, {}, state);
        const asked = [];
        scheduler.addEventListener("load", async (e) => {
            asked.push(e.url);
            await new Promise((resolve) => setTimeout(resolve, 20));
            e.setValue(inner);
        });
        await scheduler.url("entry", {});
        await settle();
        expect(asked).toEqual(["artifacts/graph/remote.0"]);
        expect(state.ran).toBe(1);
    });
});
