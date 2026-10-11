import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import ipaddr from "ipaddr.js";

// OpenAI MCP Events limits the complete UTF-8 request body, not individual fields.
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
export function assertWebhookBodySize(body: string): void {
  if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BODY_BYTES)
    throw new RangeError("Event payload exceeds 256 KiB");
}

export interface WebhookResponse {
  status: number;
  body: string;
}
export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}
export type WebhookTransport = (input: WebhookRequest) => Promise<WebhookResponse>;

export function publicAddress(value: string): boolean {
  if (!ipaddr.isValid(value)) return false;
  const address = ipaddr.parse(value);
  if (address.range() !== "unicast") return false;
  if (address.kind() === "ipv4")
    return !value.startsWith("198.18.") && !value.startsWith("198.19.");
  // Only global unicast IPv6, excluding protocol assignments and documentation.
  return (
    /^[23]/i.test(value) &&
    !value.toLowerCase().startsWith("2001:") &&
    !value.toLowerCase().startsWith("3fff:")
  );
}

export function callbackUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("Callback must be an HTTPS URL on port 443 without credentials or a fragment");
  }
  return url;
}

export function signingHeaders(input: {
  secret: string;
  previousSecrets?: string[];
  id: string;
  subscriptionId: string;
  body: string;
  timestamp: number;
}): Record<string, string> {
  const secrets = new Set([input.secret, ...(input.previousSecrets ?? [])]);
  const signatures = [...secrets].map((secret) => {
    const key = Buffer.from(secret.slice(6), "base64");
    const signature = createHmac("sha256", key)
      .update(`${input.id}.${input.timestamp}.${input.body}`)
      .digest("base64");
    return `v1,${signature}`;
  });
  return {
    "content-type": "application/json",
    "webhook-id": input.id,
    "webhook-timestamp": String(input.timestamp),
    "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": input.subscriptionId,
  };
}

/** Pin the validated address for this connection; a second DNS lookup would allow rebinding. */
export const deliverWebhook: WebhookTransport = async (input) => {
  assertWebhookBodySize(input.body);
  const url = callbackUrl(input.url);
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  if (addresses.length === 0 || addresses.some((entry) => !publicAddress(entry.address)))
    throw new Error("Callback resolves to a non-public address");
  const address = addresses[0];
  if (!address) throw new Error("Callback has no address");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: input.headers,
        agent: false,
        family: address.family,
        lookup: (_hostname, _options, done) => done(null, address.address, address.family),
        signal: AbortSignal.timeout(10_000),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            res.destroy(new Error("Callback response exceeds limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(input.body);
  });
};
