import { afterEach, expect, test, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readExecutionInstallation } from "./policy";

afterEach(() => vi.unstubAllGlobals());
test.each(["invalid", "wrong-origin"])(
  "reports %s descriptor failures without suppressing validation",
  (kind) => {
    const dom = new JSDOM("", { url: "http://localhost:6770" });
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
    const descriptor =
      kind === "invalid"
        ? { private: "hidden" }
        : {
            version: 1,
            installationId: "11111111-1111-4111-8111-111111111111",
            origin: "https://installation.example",
            environments: [
              { kind: "host", serverId: "host", endpoint: "host.example", useTls: true },
              { kind: "container", serverId: "dev", endpoint: "dev.example", useTls: true },
            ],
          };
    vi.stubGlobal("__VORTEO_EXECUTION_INSTALLATION__", descriptor);
    const events: unknown[] = [];
    dom.window.addEventListener("vorteo-boot-failed", (event) =>
      events.push((event as CustomEvent).detail),
    );
    expect(() => readExecutionInstallation()).toThrow();
    expect(events).toEqual([
      kind === "invalid" ? "installation-invalid" : "installation-origin-mismatch",
    ]);
    dom.window.close();
  },
);
