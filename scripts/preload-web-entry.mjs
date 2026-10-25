export function preloadWebEntry(html, { sourceCommit, version } = {}) {
  const preloads = [];
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1];
    const source = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(attributes)?.[2];
    if (!source || !/^\/_expo\/static\/js\/web\/[a-z0-9_.-]+\.js$/i.test(source)) continue;
    const existing = [...html.matchAll(/<link\b([^>]*)>/gi)].some(
      (link) =>
        /\brel\s*=\s*(["'])preload\1/i.test(link[1]) &&
        new RegExp(
          `\\bhref\\s*=\\s*(["'])${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`,
          "i",
        ).test(link[1]),
    );
    if (existing) continue;
    const copied = ["crossorigin", "integrity", "referrerpolicy", "nonce"].flatMap((name) => {
      const attribute = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(attributes);
      if (attribute) return [attribute[0]];
      return name === "crossorigin" && /\bcrossorigin(?=\s|$)/i.test(attributes)
        ? ['crossorigin="anonymous"']
        : [];
    });
    preloads.push(
      `<link rel="preload" as="script" href="${source}"${copied.length ? " " + copied.join(" ") : ""}>`,
    );
  }
  if (sourceCommit !== undefined || version !== undefined) {
    if (
      !/^[0-9a-f]{40,64}$/.test(sourceCommit ?? "") ||
      !/^[0-9A-Za-z.+-]{1,80}$/.test(version ?? "")
    )
      throw new Error("Startup build metadata requires a source digest and package version.");
    if (!/<meta\s+name="vorteo-build"/i.test(html))
      preloads.unshift(
        `<meta name="vorteo-build" content="${version} (${sourceCommit.slice(0, 12)})">`,
      );
  }
  if (preloads.length === 0) return html;
  if (!/<\/head>/i.test(html)) throw new Error("Web entry preload requires an HTML head.");
  return html.replace(/<\/head>/i, preloads.join("\n") + "\n</head>");
}
