# plastic-io

## Executions, budgets and cancellation (2.1)

`url()` now resolves when the execution has ended: every set function and
every connector delivery it started has settled, or its budget ran out, or it
was cancelled.  `invoke()` returns the handle behind that promise.

```javascript
const handle = scheduler.invoke("index", value, "field", undefined, {
    budget: {wallMs: 5000, hops: 10000, fanOut: 1000, depth: 256},
});
handle.cancel("user pressed stop");        // cooperative: refused at the next hop
const result = await handle.done;          // never rejects
// result: {state: "completed" | "failed" | "cancelled" | "abandoned", reason, hops, errors, duration, budget}
```

* Every event carries `executionId`, `seq`, and for edge-level events `spanId`
  and `parentSpanId`, so a run can be reconstructed from its events.
* `end` fires once per execution, last.  `endedge` fires when the node's set
  function has finished, so `afterSet` now precedes it.  `afterSet` carries
  `err` when the set function failed.
* Running out of budget emits one `error` with `code: "BUDGET_EXCEEDED"` and
  cancels the execution (`reason: "budget:<dimension>"`).  A cancellation that
  cannot drain within `graceMs` (250 ms) ends as `abandoned`.
* A node that emits on an edge after its execution has ended (a UI event, a
  timer) starts a new execution with `trigger: "edge"` and
  `parentExecutionId` on its `begin` event.
* Node code receives a `host` binding: `host.executionId`, `host.cancelled`,
  `host.signal` (an AbortSignal for fetch), `host.throwIfCancelled()`,
  `host.emit(kind, data)` (an `observation` event, counted against the
  budget), `host.now()`, `host.random()`, plus whatever the embedder adds
  through `new Scheduler(graph, context, state, logger, {host})`.
* Set functions are compiled from their source as written (`AsyncFunction`),
  so top-level `await` and modern syntax work; `{compile: "meriyah"}` keeps the
  2.0 parse-and-regenerate path.  Compiled functions are cached per scheduler.
* `onInput` / `onOutput` hooks validate values entering and leaving nodes;
  a thrown error is a `CONTRACT_VIOLATION` warning, or an error that drops the
  delivery with `{contractMode: "reject"}`.
* A connector into another graph loads that graph for itself; 2.0 redirected
  the node's remaining connectors into it.
* `scheduler.cancelAll(reason)` ends every open execution, for embedders that
  replace the graph while it runs.

## Graph scheduling engine.

![CI/CD](https://github.com/plastic-io/plastic-io/workflows/CI/CD/badge.svg?event=push)

This program can execute graphs written in the application/json+plastic-io schema.

[Documentation](https://plastic-io.github.io/plastic-io/)

[Test Coverage](https://plastic-io.github.io/plastic-io/coverage/lcov-report/)

[Repo](https://github.com/plastic-io/plastic-io)


## Major engine features

* Just in time loading and compiling of:
    - graph
    - nodes
    - embedded graphs
    - ES6 code
* Event emitter shows detailed graph execution data
* Graphs can be published, linked and embedded in other graphs
* Nodes can be published and linked
* Graphs support templating engines to create UIs using various frameworks (e.g.: Vue, React)

## Basic Usage

```
    // load the lib
    import {Scheduler} from "plastic-io";
    // instantiate the scheduler
    const scheduler = new Scheduler(myGraphJson);
    scheduler.url("url-of-a-node", "some value");
```

For more useage see [Scheduler](https://plastic-io.github.io/plastic-io/classes/_scheduler_.scheduler.html)

To create, run and debug graphs, use the plastic-io/graph-editor and the plastic-io/graph-server
