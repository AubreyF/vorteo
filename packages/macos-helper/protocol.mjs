export const protocolVersion = 2;
export const operations = Object.freeze([
  "status",
  "safari.request-consent",
  "safari.summary",
  "quit",
  "safari.discover",
  "safari.read",
  "safari.select",
  "safari.navigate",
  "safari.click",
  "safari.fill",
  "safari.choose",
]);
export function validateParameters(operation, parameters) {
  if (!operations.includes(operation)) throw new Error("Unsupported helper operation");
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters))
    throw new Error("Invalid helper parameters");
  const allowed =
    {
      "safari.read": ["windowId", "tabIndex"],
      "safari.select": ["windowId", "tabIndex"],
      "safari.navigate": ["windowId", "tabIndex", "destination"],
      "safari.click": ["windowId", "tabIndex", "pageId", "element"],
      "safari.fill": ["windowId", "tabIndex", "pageId", "element", "value"],
      "safari.choose": ["windowId", "tabIndex", "pageId", "element", "value"],
    }[operation] ?? [];
  if (
    Object.keys(parameters).length !== allowed.length ||
    allowed.some((key) => !(key in parameters))
  )
    throw new Error("Invalid helper parameters");
  for (const key of allowed) validateField(key, parameters[key]);
  if (parameters.pageId && !/^[0-9a-f-]{36}$/i.test(parameters.pageId))
    throw new Error("Invalid page handle");
  if (parameters.element && !/^e[0-9]{1,2}$/.test(parameters.element))
    throw new Error("Invalid element handle");
  return parameters;
}

function validateField(key, value) {
  if (key === "windowId" || key === "tabIndex") {
    const maximum = key === "windowId" ? 2147483647 : 10000;
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
      throw new Error("Invalid tab reference");
  } else if (typeof value !== "string" || Buffer.byteLength(value) > 4096)
    throw new Error("Invalid helper parameters");
}

export async function readParameters(stream) {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
    if (Buffer.byteLength(text) > 16384) throw new Error("Request too large");
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid helper parameters");
  }
}
