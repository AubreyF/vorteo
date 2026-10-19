import { describe, expect, test } from "vitest";
import {
  isPrivateAddress,
  NetworkPolicy,
  parseAllowedHost,
} from "./headless-host-network-policy.js";

function policy(
  config: { deniedHosts?: string[]; allowedHosts?: string[] } = {},
  dns: Record<string, string[]> = {},
) {
  return new NetworkPolicy(
    { deniedHosts: config.deniedHosts ?? [], allowedHosts: config.allowedHosts ?? [] },
    async (hostname) => {
      const addresses = dns[hostname];
      if (!addresses) throw new Error("ENOTFOUND");
      return addresses;
    },
  );
}

describe("isPrivateAddress", () => {
  test.each([
    "127.0.0.1",
    "127.8.9.10",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.1",
    "100.101.102.103",
    "0.0.0.0",
    "224.0.0.251",
    "::1",
    "::",
    "fe80::1",
    "fd7a:115c:a1e0::1",
    "fc00::5",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::127.0.0.1",
    "[::1]",
    "64:ff9b::7f00:1",
    "64:ff9b::127.0.0.1",
    "64:ff9b::a00:1",
    "64:ff9b::c0a8:101",
    "64:ff9b::6440:1",
    "2002:7f00:1::1",
    "2002:808:808::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001::1",
  ])("refuses %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  test.each([
    "93.184.215.14",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700::6810:84e5",
    "2001:4860:4860::8888",
    "64:ff9b::808:808",
    "64:ff9b::8.8.8.8",
  ])("permits public %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe("NetworkPolicy", () => {
  test("refuses private literals and local names without resolving them", async () => {
    const rules = policy();
    for (const host of [
      "127.0.0.1",
      "[::1]",
      "localhost",
      "app.localhost",
      "printer.local",
      "machine.tailnet.ts.net",
      "intranet",
    ]) {
      await expect(rules.check(host, 443)).resolves.toMatchObject({ allowed: false });
    }
  });

  test("refuses public names that resolve to private addresses", async () => {
    const rules = policy({}, { "rebind.example.com": ["93.184.215.14", "127.0.0.1"] });
    await expect(rules.check("rebind.example.com", 443)).resolves.toEqual({
      allowed: false,
      reason: "rebind.example.com resolves to private address 127.0.0.1",
    });
  });

  test("refuses public names that resolve to NAT64, 6to4 or Teredo forms of private addresses", async () => {
    const rules = policy(
      {},
      {
        "nat64.example.com": ["64:ff9b::7f00:1"],
        "sixtofour.example.com": ["2002:a00:1::1"],
        "teredo.example.com": ["2001:0:4136:e378:8000:63bf:3fff:fdd2"],
      },
    );
    for (const host of ["nat64.example.com", "sixtofour.example.com", "teredo.example.com"]) {
      await expect(rules.check(host, 443)).resolves.toMatchObject({ allowed: false });
    }
  });

  test("pins public names to the resolved address", async () => {
    const rules = policy({}, { "example.com": ["93.184.215.14"] });
    await expect(rules.check("Example.COM.", 443)).resolves.toEqual({
      allowed: true,
      addresses: ["93.184.215.14"],
    });
  });

  test("refuses names that do not resolve", async () => {
    await expect(policy().check("missing.example.com", 443)).resolves.toMatchObject({
      allowed: false,
    });
  });

  test("permits allowed hosts on their port only", async () => {
    const rules = policy(
      { allowedHosts: ["localhost:8081", "10.0.0.5"] },
      { localhost: ["127.0.0.1"] },
    );
    await expect(rules.check("localhost", 8081)).resolves.toEqual({
      allowed: true,
      addresses: ["127.0.0.1"],
    });
    await expect(rules.check("localhost", 6771)).resolves.toMatchObject({ allowed: false });
    await expect(rules.check("10.0.0.5", 22)).resolves.toEqual({
      allowed: true,
      addresses: ["10.0.0.5"],
    });
  });

  test("denied hosts win over allowed hosts", async () => {
    const rules = policy({
      deniedHosts: ["owner.example.com"],
      allowedHosts: ["owner.example.com"],
    });
    await expect(rules.check("owner.example.com", 443)).resolves.toMatchObject({ allowed: false });
    expect(rules.isDenied("OWNER.example.com")).toBe(true);
  });
});

describe("parseAllowedHost", () => {
  test("accepts hosts with optional ports", () => {
    expect(parseAllowedHost("localhost:8081")).toEqual({ hostname: "localhost", port: 8081 });
    expect(parseAllowedHost("Preview.Example.com")).toEqual({
      hostname: "preview.example.com",
      port: null,
    });
    expect(parseAllowedHost("[::1]:3000")).toEqual({ hostname: "::1", port: 3000 });
  });

  test("rejects paths and empty entries", () => {
    expect(() => parseAllowedHost("localhost/app")).toThrow("host or host:port");
    expect(() => parseAllowedHost(" ")).toThrow("cannot be empty");
  });
});
