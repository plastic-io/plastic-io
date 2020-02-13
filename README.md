# plastic-io

## Graph scheduling engine.

This program can execute graphs written in the application/json+plastic-io schema.

## Major engine features

* Just in time loading and compiling of:
    - graph
    - vectors
    - embedded graphs
    - ES6 code
* Event emitter shows detailed graph execution data
* Graphs can be published, linked and embedded in other graphs
* Vectors can be published and linked
* Graphs support templating engines to create UIs using various frameworks (e.g.: Vue, React)

## Basic Usage

```
    // load the lib
    import {Scheduler} from "plastic-io";
    // instantiate the scheduler
    const scheduler = new Scheduler(myGraphJson);
    scheduler.url("url-of-a-vector", "some value");
```

For more useage see the plastic-io documentation.

To create, run and debug graphs, use the plastic-io/graph-editor and the plastic-io/graph-server
