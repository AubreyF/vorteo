import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("EAS property-list files and synthetic provisioning metadata retain their values", async () => {
  const eas = createRequire(require.resolve("eas-cli/package.json"));
  const files = eas("./build/utils/plist.js");
  const profiles = eas("./build/credentials/ios/utils/provisioningProfile.js");
  const directory = await mkdtemp(path.join(tmpdir(), "eas-plist-"));
  const file = path.join(directory, "Info.plist");
  const value = {
    Name: "Synthetic profile",
    TeamIdentifier: ["EXAMPLE"],
    TeamName: "Fixture",
    Entitlements: { "application-identifier": "EXAMPLE.com.example.app" },
    ProvisionedDevices: ["synthetic-device"],
  };
  try {
    assert.equal(await files.readPlistAsync(file), null);
    await files.writePlistAsync(file, value);
    assert.deepEqual(await files.readPlistAsync(file), value);
    const xml = eas("@expo/plist").default.build(value);
    const encoded = Buffer.from(xml).toString("base64");
    assert.deepEqual(profiles.parse(encoded), value);
    assert.deepEqual(profiles.readAppleTeam(encoded), { teamId: "EXAMPLE", teamName: "Fixture" });
    assert.equal(profiles.isAdHocProfile(encoded), true);
    assert.equal(profiles.isEnterpriseUniversalProfile(encoded), false);
    assert.deepEqual(files.parseBinaryPlistBuffer(Buffer.from(xml)), value);
    await writeFile(file, "<notplist/>");
    await assert.rejects(files.readPlistAsync(file), /Failed to parse/);
    assert.throws(() => profiles.parse(Buffer.from("<notplist/>").toString("base64")), /malformed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const consumer of ["plist", "@expo/cli/node_modules/@expo/plist", "@expo/plist"]) {
  test(`${consumer} preserves property-list values and escaped text`, () => {
    const loaded = require(consumer);
    const plist = consumer === "plist" ? loaded : loaded.default;
    const value = {
      CFBundleIdentifier: "com.example.fixture",
      enabled: true,
      count: 3,
      names: ["first", "second"],
      nested: { text: '<tag attr="x"> & ]]> literal' },
    };
    const xml = plist.build(value);
    assert.deepEqual(plist.parse(xml), value);
    assert.equal(xml.includes('<tag attr="x">'), false);
    assert.throws(() => plist.parse("<notplist/>"), /plist|malformed/);
  });

  test(`${consumer} XML dependency rejects CDATA markup injection`, () => {
    const fromConsumer = createRequire(require.resolve(`${consumer}/package.json`));
    const { DOMImplementation, XMLSerializer, DOMParser } = fromConsumer("@xmldom/xmldom");
    const document = new DOMImplementation().createDocument(null, "root");
    assert.throws(() => document.createCDATASection("text]]><injected/>"), /Invalid character/);
    document.documentElement.appendChild(document.createCDATASection("ordinary < & text"));
    const xml = new XMLSerializer().serializeToString(document);
    const parsed = new DOMParser().parseFromString(xml, "text/xml");
    assert.equal(parsed.documentElement.textContent, "ordinary < & text");
    assert.equal(parsed.getElementsByTagName("injected").length, 0);
  });
}
