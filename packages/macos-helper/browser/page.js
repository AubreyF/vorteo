// Evaluated only by the native helper. Parameters are JSON data, never source code.
function vorteoPage(p) {
  const fail = (code) => JSON.stringify({ ok: false, code });
  if (location.origin !== p.origin) return fail("origin_changed");
  if (window.top !== window) return fail("frames_not_supported");
  const visible = (el) =>
    el.isConnected &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  const disabled = (el) =>
    el.matches(":disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    Boolean(el.closest("[inert]"));
  // Keep a handle tied to the action shown in its snapshot, not just its node
  // and label. A live page can change a link or input type without replacing it.
  const fingerprint = (el) =>
    JSON.stringify({
      tag: el.tagName,
      type: el.getAttribute("type"),
      role: el.getAttribute("role"),
      label:
        el.getAttribute("aria-label") ||
        el.labels?.[0]?.innerText ||
        el.getAttribute("placeholder") ||
        el.innerText,
      href: el.getAttribute("href"),
      formAction: el.getAttribute("formaction") ?? el.form?.action ?? null,
      formMethod: el.getAttribute("formmethod") ?? el.form?.method ?? null,
      options:
        el.tagName === "SELECT"
          ? Array.from(el.options, (option) => [option.value, option.textContent, option.disabled])
          : null,
    });
  // Only exact Host-approved public phrases leave the page. Account names,
  // arbitrary body text, generated keys, URLs and field values are withheld.
  const text = (raw) => {
    const value = String(raw || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    return p.allowedText.includes(value) ? value : "[withheld]";
  };
  const namespace = "__vorteoScopedPage";
  if (p.action === "navigate") {
    if (new URL(p.destination).origin !== p.destinationOrigin) return fail("destination_rejected");
    location.assign(p.destination);
    return JSON.stringify({ ok: true, code: "navigation_started" });
  }
  function describeElement(el, handle) {
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? el.type : tag;
    const knownTypes = [
      "text",
      "email",
      "password",
      "url",
      "search",
      "checkbox",
      "radio",
      "submit",
      "button",
      "textarea",
      "select",
      "a",
    ];
    const label =
      el.getAttribute("aria-label") ||
      el.labels?.[0]?.innerText ||
      (tag === "input" || tag === "textarea" ? el.getAttribute("placeholder") : el.innerText);
    const options =
      tag === "select"
        ? Array.from(el.options)
            .map((option) => text(option.textContent))
            .filter((optionLabel) => optionLabel !== "[withheld]")
            .slice(0, 20)
        : [];
    return {
      handle,
      tag: ["button", "a", "input", "textarea", "select", "div", "span"].includes(tag)
        ? tag
        : "div",
      options,
      type: knownTypes.includes(type) ? type : "other",
      label: text(label),
      disabled: disabled(el),
      checked: Boolean(el.checked),
    };
  }
  function snapshot() {
    const page = { id: p.pageId, nodes: new Map() };
    Object.defineProperty(window, namespace, { value: page, configurable: true });
    const elements = [];
    const nodes = document.querySelectorAll(
      "button,a,input,textarea,select,[role=button],[role=checkbox],[role=tab],[role=combobox]",
    );
    for (const el of nodes) {
      if (elements.length === 80) break;
      if (!visible(el)) continue;
      const handle = "e" + elements.length;
      page.nodes.set(handle, {
        node: el,
        fingerprint: fingerprint(el),
      });
      elements.push(describeElement(el, handle));
    }
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,[role=heading]"))
      .filter(visible)
      .slice(0, 20)
      .map((el) => text(el.innerText));
    return JSON.stringify({
      ok: true,
      code: "page_snapshot",
      origin: location.origin,
      pageId: page.id,
      readyState: document.readyState,
      headings,
      elements,
    });
  }
  if (p.action === "read") return snapshot();
  const page = window[namespace];
  if (!page || page.id !== p.pageId) return fail("stale_page");
  const entry = page.nodes.get(p.element);
  const el = entry?.node;
  if (!el || entry.fingerprint !== fingerprint(el) || !visible(el) || disabled(el))
    return fail("stale_element");
  const handlers = { click, fill, choose };
  const handler = handlers[p.action];
  if (!handler) return fail("unsupported_operation");
  const failure = handler(el);
  if (failure) return failure;
  function click(node) {
    if (
      !node.matches(
        "button,a,[role=button],[role=checkbox],[role=tab],input[type=checkbox],input[type=radio],input[type=submit],input[type=button]",
      )
    )
      return fail("element_action_rejected");
    if (node.tagName === "A" && !p.destinations.includes(new URL(node.href, location.href).href))
      return fail("destination_rejected");
    node.click();
  }
  function fill(node) {
    if (
      !(
        node.tagName === "TEXTAREA" ||
        (node.tagName === "INPUT" &&
          ["text", "email", "password", "url", "search"].includes(node.type))
      )
    )
      return fail("element_action_rejected");
    const prototype =
      node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, p.value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function choose(node) {
    if (!node.matches("select") || !p.allowedText.includes(p.value))
      return fail("element_action_rejected");
    const option = Array.from(node.options).find((item) => item.textContent.trim() === p.value);
    if (!option) return fail("element_action_rejected");
    node.value = option.value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // Invalidate all handles after a mutation; caller must read state before acting again.
  delete window[namespace];
  return JSON.stringify({ ok: true, code: "interaction_completed" });
}

globalThis.vorteoPage = vorteoPage;
