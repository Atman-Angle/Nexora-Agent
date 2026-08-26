// Additive Provider Attempt diagnostics. Legacy rows are backfilled with
// conservative defaults because the original transport facts are unavailable.
export const v9ProviderDiagnosticsMigrationSql = `
ALTER TABLE provider_attempts ADD COLUMN error_category TEXT;
ALTER TABLE provider_attempts ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_attempts ADD COLUMN partial_response INTEGER NOT NULL DEFAULT 0;
`;
