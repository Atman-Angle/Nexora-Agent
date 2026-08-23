export function compactLatest(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `…${text.slice(-(limit - 1))}`;
}

export function isFormalResultContent(input: {
  readonly completed: boolean;
  readonly text: string;
  readonly resultSummary: string | null;
}): boolean {
  return input.completed
    && input.resultSummary !== null
    && input.text.trim() === input.resultSummary.trim();
}
