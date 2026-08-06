// Persistence layer. This folder is the single mount point for every
// piece of storage the Runtime needs: the run/invocation/event ledger and
// the content-addressed artifact store. The schema scripts under schema/
// are the source of truth for the SQL DDL that the RunStore migration runs.

export { ArtifactStore, type ArtifactReference } from "./artifacts.js";

export {
  openRunStore,
  RunStore
} from "./run-store.js";

export {
  v1CoreSchemaSql,
  v2ModelCallSchemaSql,
  v3PayloadProvenanceMigrationSql,
  v4ContextCheckpointSchemaSql
} from "./schema/index.js";
