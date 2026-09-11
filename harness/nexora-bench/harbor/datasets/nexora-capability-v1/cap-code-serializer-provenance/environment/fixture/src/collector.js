import { serializeEvent } from "./serialize.js";

export function collect(events) {
  return events.map((event) => serializeEvent(event));
}
