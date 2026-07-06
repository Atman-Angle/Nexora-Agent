const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /Bearer\s+[A-Za-z0-9._-]+/g, replacement: "Bearer ***" },
  { re: /sk-[A-Za-z0-9_-]{8,}/g, replacement: "sk-***" },
  { re: /[Aa]uthorization[:\s]+[A-Za-z0-9._-]+/g, replacement: "authorization ***" }
];

export function redactForEvidence(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern.re, pattern.replacement);
  }
  return result;
}
