interface ConnectionToastInput {
  content: unknown;
  testID?: string;
}

// Match client transport errors only. Permission, provider, and operation failures
// must retain their own error presentation.
export function isConnectionToast({ content, testID }: ConnectionToastInput): boolean {
  if (testID === "agent-reconnecting-toast") return true;
  if (typeof content !== "string") return false;
  return /^Transport (?:closed(?: \(code \d+\))?|not connected(?: \(status: [a-z]+\))?)$/.test(
    content.trim(),
  );
}
