import { describe, expect, it } from "vitest";
import { isAppNavigationUrl } from "./navigation.js";

describe("application navigation authority", () => {
  it.each(["paseo://app/", "paseo://app/hosts/local/agents/one?tab=files#latest"])(
    "allows packaged application routes: %s",
    (url) => expect(isAppNavigationUrl(url, "paseo://app/")).toBe(true),
  );

  it.each([
    "https://example.com/",
    "paseo://other/",
    "other://app/",
    "paseo://app.example.com/",
    "paseo://app@evil/",
    "paseo://user@app/",
    "paseo://app:9000/",
    "file:///tmp/page.html",
    "javascript:alert(1)",
    "data:text/html,test",
    "about:blank",
    "not a URL",
  ])("rejects destinations outside the packaged application: %s", (url) => {
    expect(isAppNavigationUrl(url, "paseo://app/")).toBe(false);
  });

  it("allows development routes only on the configured origin", () => {
    const base = "http://localhost:8081/";
    expect(isAppNavigationUrl("http://localhost:8081/settings?tab=theme", base)).toBe(true);
    expect(isAppNavigationUrl("http://localhost:8082/", base)).toBe(false);
    expect(isAppNavigationUrl("http://localhost.example.com:8081/", base)).toBe(false);
    expect(isAppNavigationUrl("https://localhost:8081/", base)).toBe(false);
  });
});
