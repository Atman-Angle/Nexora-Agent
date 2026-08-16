// Additive Provider telemetry. Historical Attempts retain null because cache
// usage cannot be reconstructed after the physical request.
export const v8ProviderUsageMigrationSql = `
ALTER TABLE provider_attempts ADD COLUMN provider_usage_json TEXT;
`;
