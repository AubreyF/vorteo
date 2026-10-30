import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { servicePath, withServicePath } from "./service-path.mjs";

describe("service PATH", () => {
  test("puts node, ~/.local/bin and the owner's PATH ahead of the platform folders", () => {
    const value = servicePath({
      platform: "darwin",
      home: "/Users/owner",
      nodeDirectory: "/Users/owner/.nvm/versions/node/v24/bin",
      envPath: "/opt/homebrew/bin:relative/bin:/work/node_modules/.bin:/Users/owner/.local/bin",
    });
    assert.equal(
      value,
      "/Users/owner/.nvm/versions/node/v24/bin:/Users/owner/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });

  test("replaces PATH in a launchd plist and a systemd unit", () => {
    const plist = "<key>PATH</key>\n    <string>/usr/bin:/bin</string>";
    assert.equal(
      withServicePath(plist, "/a&b:/usr/bin"),
      "<key>PATH</key>\n    <string>/a&amp;b:/usr/bin</string>",
    );
    const unit = "[Service]\nEnvironment=PATH=/usr/bin\nExecStart=/x";
    assert.equal(
      withServicePath(unit, "/home/o/.local/bin:/usr/bin"),
      '[Service]\nEnvironment="PATH=/home/o/.local/bin:/usr/bin"\nExecStart=/x',
    );
    assert.equal(withServicePath("no path here", "/x"), "no path here");
  });
});
