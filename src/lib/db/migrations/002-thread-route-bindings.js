import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 2,
  name: "thread-route-bindings",
  up(db) {
    const definition = TABLES.threadRouteBindings;
    db.exec(buildCreateTableSql("threadRouteBindings", definition));
    for (const index of definition.indexes || []) db.exec(index);
  },
};
