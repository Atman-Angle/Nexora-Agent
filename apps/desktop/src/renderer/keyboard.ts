export function shouldSendOnEnter(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing">,
  busy: boolean
): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && !busy;
}
