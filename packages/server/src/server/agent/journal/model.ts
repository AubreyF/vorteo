export class JournalError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "JournalError";
  }
}
