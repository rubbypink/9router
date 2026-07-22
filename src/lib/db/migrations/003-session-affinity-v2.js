import { TABLES, buildCreateTableSql } from "../schema.js";

const TABLE_NAMES = [
  "sessionModelBindings",
  "sessionConnectionBindings",
  "providerRoundRobinCursors",
];

export default {
  version: 3,
  name: "session-affinity-v2",
  up(db) {
    for (const name of TABLE_NAMES) {
      const definition = TABLES[name];
      db.exec(buildCreateTableSql(name, definition));
      for (const index of definition.indexes || []) db.exec(index);
    }
  },
};
