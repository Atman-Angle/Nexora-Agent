// Schema v3: payload digest and artifact provenance on tool_invocations.
// Applied when user_version < 3.

export const v3PayloadProvenanceMigrationSql = `
ALTER TABLE tool_invocations ADD COLUMN payload_digest TEXT;
ALTER TABLE tool_invocations ADD COLUMN payload_artifact_ref TEXT;
`;
