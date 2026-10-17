import { isDeepStrictEqual } from "node:util";

type RequireBinding = (value: unknown, message: string) => asserts value;

/** Detached data preserves original function references and rejects accessors. */
function copyBinding<T>(value: T, requireProof: RequireBinding): T {
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  requireProof(
    Array.isArray(value) ||
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null,
    "custody binding must contain plain data",
  );
  const result = (Array.isArray(value) ? [] : {}) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireProof("value" in descriptor && descriptor.enumerable, "custody binding has an accessor");
    Object.defineProperty(result, key, {
      value: copyBinding(descriptor.value, requireProof),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result as T;
}

/** Keep the comparison baseline private. Consumers receive a second copy, so
 * a callback cannot rewrite that baseline through its receiver. */
export function retainCustodyBinding<T>(source: T, requireProof: RequireBinding) {
  const captured = copyBinding(source, requireProof);
  const snapshot = copyBinding(captured, requireProof);
  return {
    snapshot,
    check: () =>
      requireProof(
        isDeepStrictEqual(copyBinding(source, requireProof), captured) &&
          isDeepStrictEqual(copyBinding(snapshot, requireProof), captured),
        "retained binding changed",
      ),
  };
}

/** Capture the original receiver and callback as well as detached proof data. */
export function retainCustodyProof<T extends { assertCurrent(): void }>(
  source: T,
  requireProof: RequireBinding,
) {
  const binding = retainCustodyBinding(source, requireProof);
  const callback = source.assertCurrent;
  requireProof(typeof callback === "function", "custody callback is absent");
  return {
    data: binding.snapshot,
    check: binding.check,
    assertCurrent() {
      binding.check();
      requireProof(callback.call(source) === undefined, "proof must be synchronous");
      binding.check();
    },
  };
}
