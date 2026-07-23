import { TABLES, buildCreateTableSql } from "../schema.js";

const migration = {
  version: 4,
  name: "gemini-thought-signatures",
  up(db) {
    for (const tableName of ["geminiThoughtSignatures", "geminiThoughtSignatureTombstones"]) {
      const definition = TABLES[tableName];
      db.exec(buildCreateTableSql(tableName, definition));
      for (const index of definition.indexes || []) db.exec(index);
    }
  },
};

export default migration;
