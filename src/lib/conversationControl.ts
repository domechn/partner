export type ConversationControl =
  | { kind: "confirm" }
  | { kind: "cancel" };

const CONFIRM_PATTERNS = [
  /确认执行/,
  /可以执行/,
  /确定.*执行/,
  /执行吧/,
];

const CANCEL_PATTERNS = [
  /^取消(?:执行|操作)?$/,
  /别执行/,
  /不用了/,
  /取消这次操作/,
  /不要执行/,
  /算了/,
];

export function parseConversationControl(
  raw: string,
): ConversationControl | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }

  if (CONFIRM_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "confirm" };
  }

  if (CANCEL_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "cancel" };
  }

  return null;
}