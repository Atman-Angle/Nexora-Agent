export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  const absolute = Math.abs(rounded);
  if (absolute >= 1_000_000) return `${trimUnit(rounded / 1_000_000)}M`;
  if (absolute >= 1_000) return `${Math.round(rounded / 1_000)}K`;
  return String(rounded);
}

export function parseTokenCount(value: string): number | null {
  const normalized = value.trim().replace(/,/g, "").toUpperCase();
  const match = /^(\d+(?:\.\d+)?)\s*([KM])?$/.exec(normalized);
  if (match === null) return null;
  const amount = Number(match[1]);
  const multiplier = match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  const tokens = amount * multiplier;
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return null;
  return tokens;
}

export function resolveTokenInput(value: string, original: number | null, edited: boolean): number | null {
  if (!edited) return original;
  return value.trim() === "" ? null : parseTokenCount(value);
}

function trimUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}
