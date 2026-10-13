import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

for (const consumer of ["plist", "@expo/cli/node_modules/@expo/plist"]) {
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
