type Section = { readonly bytes: number; readonly tokens: number; readonly digest: string };
type Sections = Readonly<Record<string, Section>>;

export function diffContextSections(previous: Sections, next: Sections) {
  const names = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort();
  return Object.freeze({
    added: names.filter((name) => previous[name] === undefined && next[name] !== undefined),
    removed: names.filter((name) => previous[name] !== undefined && next[name] === undefined),
    changed: names.filter((name) => previous[name] !== undefined && next[name] !== undefined
      && previous[name]!.digest !== next[name]!.digest),
    repeated: names.filter((name) => previous[name] !== undefined && next[name] !== undefined
      && previous[name]!.digest === next[name]!.digest),
    tokenDelta: Object.fromEntries(names.map((name) => [
      name,
      (next[name]?.tokens ?? 0) - (previous[name]?.tokens ?? 0)
    ]))
  });
}
