import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { preloadWebEntry } from "../../../../scripts/preload-web-entry.mjs";

interface VitestProject {
  provide: (key: "passwordlessRelayUrl", value: string) => void;
}

export default async function setup(project: VitestProject): Promise<() => Promise<void>> {
  const startupHtml = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
  let startupHealthMode = "normal";
  let interruptedScriptRequests = 0;
  let startupHealthRequests = 0;
  let heldScriptRequests = 0;
  const heldResponses = new Set<ServerResponse>();
  function handleHeldScriptRequest(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.url === "/startup-fixture-stats") {
      response.end(JSON.stringify({ startupHealthRequests, heldScriptRequests }));
    } else if (request.url === "/startup-progress-held-script" && request.method === "POST") {
      for (const held of heldResponses) held.write("// transfer still in progress\n");
      response.end("{}");
    } else if (request.url === "/startup-release-held-script" && request.method === "POST") {
      for (const held of heldResponses)
        held.end("window.__startupHeldEntryCount = (window.__startupHeldEntryCount || 0) + 1;");
      heldResponses.clear();
      response.end("{}");
    } else if (request.url === "/_expo/static/js/web/held-0123456789abcdef.js") {
      heldScriptRequests++;
      response.setHeader("Content-Type", "application/javascript");
      response.setHeader("Cache-Control", "no-store");
      response.flushHeaders();
      heldResponses.add(response);
      response.on("close", () => heldResponses.delete(response));
    } else if (request.url === "/startup-held-fixture") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        preloadWebEntry(
          startupHtml.replace(
            "</body>",
            '<script src="/_expo/static/js/web/held-0123456789abcdef.js" defer crossorigin="anonymous"></script></body>',
          ),
        ),
      );
    } else return false;
    return true;
  }
  const server = createServer((request, response) => {
    if (request.url !== "/cors-restricted-health")
      response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Content-Type", "application/json");
    if (handleHeldScriptRequest(request, response)) return;
    if (request.url === "/startup-test-mode" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        startupHealthMode = body;
        interruptedScriptRequests = 0;
        startupHealthRequests = 0;
        heldScriptRequests = 0;
        for (const held of heldResponses) held.destroy();
        heldResponses.clear();
        response.end("{}");
      });
    } else if (request.url === "/_expo/static/js/web/interrupted-0123456789abcdef.js") {
      interruptedScriptRequests++;
      response.setHeader("Content-Type", "application/javascript");
      response.setHeader("Cache-Control", "no-store");
      if (interruptedScriptRequests === 1) {
        response.setHeader("Content-Length", "200");
        response.write("window.__startupFixtureEntryCount = ");
        setTimeout(() => response.destroy(), 20);
      } else
        response.end(
          "window.__startupFixtureEntryCount = (window.__startupFixtureEntryCount || 0) + 1;",
        );
    } else if (request.url === "/_expo/static/js/web/safe-error-0123456789abcdef.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end("Object.keys(undefined);");
    } else if (request.url === "/_expo/static/js/web/throws-0123456789abcdef.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end('throw new TypeError("private-session-value-must-not-leak");');
    } else if (request.url === "/startup-fixture") {
      response.setHeader("Content-Type", "text/html");
      response.end(startupHtml);
    } else if (request.url === "/api/installation/restart-summary") {
      response.end(
        JSON.stringify({ requested: 0, queued: 0, running: 0, privateData: "must-not-leak" }),
      );
    } else if (request.url === "/api/installation/health") {
      startupHealthRequests++;
      if (startupHealthMode === "invalid") response.end("<html>Not installation health</html>");
      else if (startupHealthMode === "disconnected") response.destroy();
      else if (startupHealthMode === "slow") setTimeout(() => response.end("{}"), 9000);
      else response.end(JSON.stringify({ installationId: "00000000-0000-4000-8000-000000000001" }));
    } else if (request.url === "/api/health" || request.url === "/cors-restricted-health")
      response.end(JSON.stringify({ status: "ok" }));
    else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Unknown fixture route" }));
    }
  });
  const clients = new Set<Duplex>();

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/relay" && request.url !== "/ws") {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    // This relay-style server deliberately selects no subprotocol.
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    if (head.length > 0) {
      socket.unshift(head);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Browser WebSocket regression server did not expose a TCP address");
  }
  project.provide("passwordlessRelayUrl", `ws://127.0.0.1:${address.port}/relay`);

  return async () => {
    for (const client of clients) {
      client.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
}
