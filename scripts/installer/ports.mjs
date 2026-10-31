// Port selection. Loopback ports must be free on this machine; HTTPS ports are
// `tailscale serve` ports and must be unused by existing serve routes.

export const DEFAULT_PORTS = Object.freeze({
  coordinator: 6770,
  host: 6771,
  devRelay: 6768,
  https: 44444,
  hostHttps: 44445,
  devHttps: 44446,
});

const LOOPBACK = new Set(["coordinator", "host", "devRelay"]);
const ATTEMPTS = 200;

/**
 * Chooses each wanted port, starting at its default and moving up past ports that are
 * busy, already chosen, or the default of a port not chosen yet (so one conflict does
 * not push every later port off its default). `fixed` ports are kept as given, such as a
 * legacy deployment's own published port.
 *
 * @param {{ wanted: string[], isPortFree: (port: number) => Promise<boolean>,
 *   servePorts?: Set<number>, fixed?: Record<string, number> }} input
 */
export async function choosePorts({ wanted, isPortFree, servePorts = new Set(), fixed = {} }) {
  const chosen = {};
  const taken = new Set(Object.values(fixed));
  for (const key of wanted) {
    if (fixed[key] !== undefined) {
      chosen[key] = fixed[key];
      continue;
    }
    const reserved = new Set(
      wanted
        .filter((other) => other !== key && chosen[other] === undefined)
        .map((other) => DEFAULT_PORTS[other]),
    );
    let port = DEFAULT_PORTS[key];
    let found = false;
    for (let attempt = 0; attempt < ATTEMPTS && port <= 65535; attempt += 1, port += 1) {
      if (taken.has(port) || reserved.has(port)) continue;
      const free = LOOPBACK.has(key) ? await isPortFree(port) : !servePorts.has(port);
      if (free) {
        found = true;
        break;
      }
    }
    if (!found) throw new Error(`No free port near ${DEFAULT_PORTS[key]} for ${key}`);
    chosen[key] = port;
    taken.add(port);
  }
  return chosen;
}

/** HTTPS ports that existing `tailscale serve` routes own on this node. */
export function servePortsInUse(serve, hostname) {
  const ports = new Set();
  for (const key of Object.keys(serve?.TCP ?? {})) ports.add(Number(key));
  for (const table of [serve?.Web, serve?.AllowFunnel]) {
    for (const key of Object.keys(table ?? {})) {
      const [name, port] = key.split(/:(?=\d+$)/);
      if (!hostname || name === hostname) ports.add(Number(port));
    }
  }
  return ports;
}
