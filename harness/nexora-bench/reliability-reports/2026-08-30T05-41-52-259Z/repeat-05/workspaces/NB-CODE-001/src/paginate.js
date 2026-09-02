export function pageBounds(page, pageSize, total) {
  const start = page * pageSize;
  const end = Math.min(start + pageSize, total);
  return { start, end };
}
