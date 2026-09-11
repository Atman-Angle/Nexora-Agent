export function serializeEvent(event) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    type: event.type,
    value: event.value
  }) + "\n";
}
