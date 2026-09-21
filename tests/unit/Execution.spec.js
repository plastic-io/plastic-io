/* global describe it expect jest beforeEach require global setTimeout */
const Scheduler = require("../../dist/index.js").default;
const {ExecutionCancelled} = require("../../dist/index.js");

/** a graph from a compact description: nodes[id] = {set, to: [[field, targetId, targetField]]} */
function graph(nodes, id = "g") {
    return {
        id, url: id, version: 0, properties: {name: id},
        nodes: Object.keys(nodes).map((nodeId) => {
            const spec = nodes[nodeId];
            const edges = {};
            (spec.to || []).forEach(([field, target, targetField]) => {
                edges[field] = edges[field] || {field, connectors: []};
                edges[field].connectors.push({id: `${nodeId}-${field}-${target}`, nodeId: target, field: targetField || "in", graphId: id, version: 0});
            });
            (spec.fields || []).forEach((field) => { edges[field] = edges[field] || {field, connectors: []}; });
            return {
                id: nodeId, url: nodeId, version: 0, graphId: id, artifact: null, data: spec.data || null,
                properties: {inputs: [{name: "in"}], outputs: Object.keys(edges).map((name) => ({name})), name: nodeId},
                template: {set: spec.set || "", vue: ""},
                edges: Object.keys(edges).map((k) => edges[k]),
            };
        }),
    };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function record(scheduler, names) {
    const seq = [];
    names.forEach((n) => scheduler.addEventListener(n, (e) => seq.push([n, e])));
    return seq;
}

describe("execution handles and completion (2.1)", () => {
    it("url() resolves only when the asynchronous work downstream has settled, and end comes last", async () => {
        const order = [];
        const g = graph({
            a: {set: "await new Promise(r => setTimeout(r, 20)); state.order.push('a:timer'); edges.out = value;", to: [["out", "b"]]},
            b: {set: "state.order.push('b:' + value); await new Promise(r => setTimeout(r, 10)); state.order.push('b:done');"},
        });
        const scheduler = new Scheduler(g, {}, {order});
        scheduler.addEventListener("end", (e) => order.push("end:" + e.state + ":" + e.hops));
        const result = await scheduler.url("a", "v");
        expect(order).toEqual(["a:timer", "b:v", "b:done", "end:completed:2"]);
        expect(result).toMatchObject({state: "completed", hops: 2, errors: 0, spans: 2});
        expect(result.executionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(Object.keys(scheduler.executions)).toEqual([]);
    });

    it("every event carries the execution id, a sequence number and span ids that nest", async () => {
        const g = graph({a: {set: "edges.out = value;", to: [["out", "b"]]}, b: {set: "return value;"}});
        const scheduler = new Scheduler(g);
        const seq = record(scheduler, ["begin", "beginedge", "set", "afterSet", "endedge", "beginconnector", "endconnector", "end"]);
        const handle = scheduler.invoke("a", 1);
        expect(handle.state).toBe("running");
        const result = await handle.done;
        const ids = new Set(seq.map(([, e]) => e.executionId));
        expect(ids).toEqual(new Set([result.executionId]));
        const seqs = seq.map(([, e]) => e.seq);
        expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
        const edges = seq.filter(([n]) => n === "beginedge").map(([, e]) => e);
        expect(edges).toHaveLength(2);
        expect(edges[0].parentSpanId).toBeUndefined();
        expect(edges[1].parentSpanId).toBe(edges[0].spanId);
        expect(seq[seq.length - 1][0]).toBe("end");
    });

    it("cancel() stops the execution between hops and settles the handle", async () => {
        const g = graph({
            a: {set: "for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 5)); edges.out = i; }", to: [["out", "b"]]},
            b: {set: "state.seen.push(value);"},
        });
        const state = {seen: []};
        const scheduler = new Scheduler(g, {}, state);
        const handle = scheduler.invoke("a");
        await wait(12);
        await handle.cancel("test");
        expect(handle.state).toBe("cancelled");
        const seenAtCancel = state.seen.length;
        expect(seenAtCancel).toBeGreaterThanOrEqual(1);
        expect(seenAtCancel).toBeLessThan(5);
        await wait(40);
        // the loop in a's set function keeps running (nothing can stop JS mid-function), but its emissions are refused
        expect(state.seen.length).toBe(seenAtCancel);
        const result = await handle.done;
        expect(result.state).toBe("cancelled");
        expect(result.reason).toMatch(/test/);
    });

    it("an unbounded asynchronous cycle is stopped by the hop budget with one BUDGET_EXCEEDED error", async () => {
        const g = graph({a: {set: "await Promise.resolve(); edges.out = value + 1;", to: [["out", "a"]]}});
        const scheduler = new Scheduler(g, {}, {}, undefined, {budget: {hops: 25}});
        const errors = record(scheduler, ["error"]);
        const result = await scheduler.url("a", 0);
        expect(result.state).toBe("cancelled");
        expect(result.reason).toBe("budget:hops");
        expect(result.hops).toBe(26);
        expect(errors.filter(([, e]) => e.code === "BUDGET_EXCEEDED")).toHaveLength(1);
        expect(errors[0][1]).toMatchObject({dimension: "hops", used: 26, limit: 25});
        expect(result.budget.exceeded).toBe("hops");
    });

    it("an emission wider than the fan-out budget is refused", async () => {
        const g = graph({a: {set: "edges.out = value;", to: [["out", "b"], ["out", "c"], ["out", "d"]]}, b: {set: ""}, c: {set: ""}, d: {set: ""}});
        const scheduler = new Scheduler(g, {}, {}, undefined, {budget: {fanOut: 2}});
        const edges = record(scheduler, ["beginedge"]);
        const result = await scheduler.url("a", 1);
        expect(edges).toHaveLength(1);
        expect(result.budget.exceeded).toBe("fanOut");
    });

    it("the wall budget ends an execution whose promises never settle, as abandoned", async () => {
        const g = graph({a: {set: "await new Promise(() => {});"}});
        const scheduler = new Scheduler(g);
        const started = Date.now();
        const result = await scheduler.invoke("a", null, undefined, undefined, {budget: {wallMs: 30, graceMs: 10}}).done;
        expect(Date.now() - started).toBeLessThan(500);
        expect(result.state).toBe("abandoned");
        expect(result.reason).toMatch(/budget:wallMs/);
    });

    it("an emission after the execution has ended starts a new execution of its own", async () => {
        const g = graph({
            a: {set: "setTimeout(() => { edges.out = 'late'; }, 15);", to: [["out", "b"]]},
            b: {set: "state.seen.push(value);"},
        });
        const state = {seen: []};
        const scheduler = new Scheduler(g, {}, state);
        const begins = record(scheduler, ["begin"]);
        const ends = record(scheduler, ["end"]);
        const first = await scheduler.url("a");
        expect(first.state).toBe("completed");
        expect(state.seen).toEqual([]);
        await wait(40);
        expect(state.seen).toEqual(["late"]);
        expect(begins).toHaveLength(2);
        expect(begins[1][1]).toMatchObject({trigger: "edge", parentExecutionId: first.executionId});
        expect(ends).toHaveLength(2);
        expect(ends[1][1].executionId).toBe(begins[1][1].executionId);
        expect(ends[1][1].hops).toBe(1);
    });

    it("a connector into another graph loads that graph for itself without redirecting the node's other connectors", async () => {
        const inner = graph({x: {set: "state.seen.push('inner:' + value);"}}, "inner");
        const g = graph({
            a: {set: "edges.out = value;", to: [["out", "b"], ["out", "x"], ["out", "c"]]},
            b: {set: "state.seen.push('b:' + value);"},
            c: {set: "state.seen.push('c:' + value);"},
        });
        // the middle connector points at the other graph
        g.nodes[0].edges[0].connectors[1].graphId = "inner";
        const state = {seen: []};
        const scheduler = new Scheduler(g, {}, state);
        scheduler.addEventListener("load", (e) => { if (/inner/.test(e.url)) e.setValue(inner); });
        const errors = record(scheduler, ["error"]);
        const result = await scheduler.url("a", 1);
        expect(errors).toEqual([]);
        expect(state.seen.sort()).toEqual(["b:1", "c:1", "inner:1"]);
        expect(result.hops).toBe(4);
    });

    it("node code gets a host binding: identity, cancellation, observations", async () => {
        const g = graph({a: {set: "host.emit('note', {v: value}); state.id = host.executionId; state.custom = host.hello(); host.throwIfCancelled(); return host.cancelled;"}});
        const state = {};
        const scheduler = new Scheduler(g, {}, state, undefined, {host: {hello: () => "world"}});
        const observations = record(scheduler, ["observation"]);
        const after = record(scheduler, ["afterSet"]);
        const result = await scheduler.url("a", 7);
        expect(state.id).toBe(result.executionId);
        expect(state.custom).toBe("world");
        expect(observations).toHaveLength(1);
        expect(observations[0][1]).toMatchObject({kind: "note", data: {v: 7}, nodeId: "a", executionId: result.executionId});
        expect(after[0][1].return).toBe(false);
    });

    it("compiles source directly, so top-level await and modern syntax work; a parse error is reported with a location", async () => {
        const g = graph({
            a: {set: "const v = await Promise.resolve(value ?? 'fallback'); state.got = v?.length; return v;"},
            bad: {set: "const = ;"},
        });
        const state = {};
        const scheduler = new Scheduler(g, {}, state);
        const after = record(scheduler, ["afterSet"]);
        const errors = record(scheduler, ["error"]);
        await scheduler.url("a", "abc");
        expect(state.got).toBe(3);
        expect(after[0][1].return).toBe("abc");
        const result = await scheduler.url("bad");
        expect(result.state).toBe("completed");
        expect(result.errors).toBeGreaterThanOrEqual(1);
        expect(errors.some(([, e]) => /Unexpected|Expected/.test(String(e.err)))).toBe(true);
        expect(after[1][1].err).toBeTruthy();   // afterSet reports the failure again, as 2.0.1 did
    });

    it("keeps the meriyah path behind an option", async () => {
        const g = graph({a: {set: "return value * 2;"}});
        const scheduler = new Scheduler(g, {}, {}, undefined, {compile: "meriyah"});
        const after = record(scheduler, ["afterSet"]);
        await scheduler.url("a", 21);
        expect(after[0][1].return).toBe(42);
        expect(Object.keys(scheduler.compiled)[0]).toMatch(/^meriyah:/);
    });

    it("contract hooks can warn or refuse a delivery", async () => {
        const g = graph({a: {set: "edges.out = value;", to: [["out", "b"]]}, b: {set: "state.seen.push(value);"}});
        const onInput = ({value}) => { if (typeof value !== "number") throw new Error("expected a number"); };
        const warnState = {seen: []};
        const warn = new Scheduler(g, {}, warnState, undefined, {onInput});
        const warnings = record(warn, ["warning"]);
        await warn.url("a", "not a number");
        expect(warnState.seen).toEqual(["not a number"]);
        expect(warnings[0][1]).toMatchObject({code: "CONTRACT_VIOLATION"});
        const rejectState = {seen: []};
        const strict = new Scheduler(g, {}, rejectState, undefined, {onInput, contractMode: "reject"});
        const errors = record(strict, ["error"]);
        const result = await strict.url("a", "not a number");
        expect(rejectState.seen).toEqual([]);
        expect(errors[0][1]).toMatchObject({code: "CONTRACT_VIOLATION"});
        expect(result.hops).toBe(1);
    });

    it("cancelAll ends every open execution", async () => {
        const g = graph({a: {set: "await new Promise(() => {});"}});
        const scheduler = new Scheduler(g, {}, {}, undefined, {budget: {graceMs: 5}});
        const h1 = scheduler.invoke("a");
        const h2 = scheduler.invoke("a");
        expect(Object.keys(scheduler.executions)).toHaveLength(2);
        await scheduler.cancelAll("graph changed");
        expect([h1.state, h2.state]).toEqual(["abandoned", "abandoned"]);
        expect(Object.keys(scheduler.executions)).toHaveLength(0);
    });

    it("ExecutionCancelled is exported", () => {
        expect(new ExecutionCancelled("x").name).toBe("ExecutionCancelled");
    });
});
