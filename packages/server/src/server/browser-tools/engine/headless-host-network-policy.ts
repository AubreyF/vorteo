import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Decides which hosts the headless browser may reach. Private, loopback,
// link-local, CGNAT/tailnet and other non-public destinations are refused by
// default, both as literals and after DNS resolution, so a page cannot reach
// services on this machine or its networks. Explicit allow entries open a
// specific host (and optionally port); denied hosts are refused even then.

const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT, including Tailscale addresses
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  // 6to4 and Teredo embed IPv4 addresses (Teredo obfuscates its client
  // address). Both are deprecated, so refuse the whole prefixes.
  ["2002::", 16],
  ["2001::", 32],
  ["fc00::", 7], // unique local, including Tailscale
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv6");
}

// Names that only resolve inside a machine or private network.
const PRIVATE_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".ts.net"];

export interface NetworkPolicyConfig {
  // Hostnames that are always refused, such as the protected installation interface.
  deniedHosts: readonly string[];
  // "host" or "host:port" entries that may be reached even when private.
  allowedHosts: readonly string[];
}

export type NetworkDecision =
  // Checked addresses to connect to, in resolver order. Empty only from
  // checkName for an allowed name that still needs resolution.
  { allowed: true; addresses: string[] } | { allowed: false; reason: string };

export type HostLookup = (hostname: string) => Promise<readonly string[]>;

interface AllowEntry {
  hostname: string;
  port: number | null;
}

export function normalizeHostname(value: string): string {
  let hostname = value.trim().toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  return hostname;
}

export function parseAllowedHost(value: string): AllowEntry {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("An allowed host cannot be empty.");
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
  } catch {
    throw new Error(`Invalid allowed host: ${value}`);
  }
  if (!url.hostname || url.pathname !== "/" || url.search || url.username) {
    throw new Error(`Invalid allowed host: ${value}. Use host or host:port.`);
  }
  // An explicit port in the entry restricts it; URL drops default ports, so read it back.
  const explicitPort = /:(\d+)(?:\/)?$/.exec(trimmed)?.[1];
  return {
    hostname: normalizeHostname(url.hostname),
    port: explicitPort ? Number(explicitPort) : null,
  };
}

// Expands a valid IPv6 address into its eight 16-bit groups.
function ipv6Groups(address: string): number[] {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (part: string) =>
    part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const front = parse(head);
  if (tail === undefined) return front;
  const back = parse(tail);
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}

function groupsToIpv4(high: number, low: number): string {
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isPrivateAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return privateRanges.check(normalized, "ipv4");
  if (family !== 6) return false;
  const groups = ipv6Groups(normalized);
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96) and NAT64
  // (64:ff9b::/96) addresses inherit the decision for their embedded IPv4.
  const embedsIpv4 =
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) ||
    (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0);
  if (embedsIpv4) return privateRanges.check(groupsToIpv4(g6, g7), "ipv4");
  return privateRanges.check(normalized, "ipv6");
}

function isPrivateName(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    !hostname.includes(".") ||
    PRIVATE_NAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

async function defaultLookup(hostname: string): Promise<readonly string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

export class NetworkPolicy {
  private readonly denied: ReadonlySet<string>;
  private readonly allowed: readonly AllowEntry[];

  public constructor(
    config: NetworkPolicyConfig,
    private readonly lookup: HostLookup = defaultLookup,
  ) {
    this.denied = new Set(config.deniedHosts.map(normalizeHostname));
    this.allowed = config.allowedHosts.map(parseAllowedHost);
  }

  public isDenied(hostname: string): boolean {
    return this.denied.has(normalizeHostname(hostname));
  }

  // Decision from the name alone. "resolve" means DNS must decide.
  public checkName(hostname: string, port: number): NetworkDecision | "resolve" {
    const host = normalizeHostname(hostname);
    if (this.denied.has(host)) return { allowed: false, reason: `${host} is denied` };
    if (this.allowed.some((entry) => entry.hostname === host && (entry.port ?? port) === port)) {
      return { allowed: true, addresses: isIP(host) ? [host] : [] };
    }
    if (isIP(host)) {
      return isPrivateAddress(host)
        ? { allowed: false, reason: `${host} is a private address` }
        : { allowed: true, addresses: [host] };
    }
    if (isPrivateName(host)) return { allowed: false, reason: `${host} is a private name` };
    return "resolve";
  }

  // Full decision. A permitted name returns its resolved addresses, so the
  // connection uses only addresses that were checked.
  public async check(hostname: string, port: number): Promise<NetworkDecision> {
    const byName = this.checkName(hostname, port);
    if (byName !== "resolve" && (!byName.allowed || byName.addresses.length > 0)) return byName;
    const host = normalizeHostname(hostname);
    let addresses: readonly string[];
    try {
      addresses = await this.lookup(host);
    } catch {
      return { allowed: false, reason: `${host} could not be resolved` };
    }
    if (addresses.length === 0) return { allowed: false, reason: `${host} did not resolve` };
    // An explicitly allowed name may resolve anywhere, including this machine.
    if (byName !== "resolve") return { allowed: true, addresses: [...addresses] };
    const blocked = addresses.find((address) => isPrivateAddress(address));
    if (blocked)
      return { allowed: false, reason: `${host} resolves to private address ${blocked}` };
    return { allowed: true, addresses: [...addresses] };
  }
}
