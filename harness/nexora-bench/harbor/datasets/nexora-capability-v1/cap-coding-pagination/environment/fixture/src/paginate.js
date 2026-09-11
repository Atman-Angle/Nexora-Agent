export function pageBounds(page, pageSize, total) {
  const start = page * pageSize;
  const end = Math.min(start + pageSize - 1, total);
  return { start, end };
}
