/** Authored examples, never reports about real projects or executed work. */
export const DEMO_STORIES = [
  {
    workspace: "Design review",
    title: "Review accessible navigation",
    request: "Review Atlas navigation. Make it work well with a keyboard and on a phone.",
    summary:
      "The sample navigation preserves the active page and exposes it to assistive technology.",
    points: [
      "Visible keyboard focus",
      "Comfortable touch targets",
      "Selected page retained between views",
    ],
    code: "<NavigationItem aria-current={selected ? 'page' : undefined}>\n  {project.name}\n</NavigationItem>",
    tasks: [
      ["Inspect the existing interface", "completed"],
      ["Implement keyboard navigation", "completed"],
      ["Review desktop and phone layouts", "review"],
      ["Publish the release", "blocked"],
    ],
    journal: "Sample decision: retain navigation order when the layout becomes compact.",
    next: "Review the desktop and phone layouts before the simulated release can proceed.",
  },
  {
    workspace: "Release preparation",
    title: "Prepare Atlas release notes",
    request: "Draft release notes for the navigation update and make the review checklist clear.",
    summary: "The sample release notes separate accessibility changes from visual refinements.",
    points: [
      "Describe keyboard navigation",
      "Include a compact-layout screenshot",
      "Link the review checklist",
    ],
    code: "## Navigation\n- Visible focus for keyboard users\n- Larger touch targets\n- Active page announced to screen readers",
    tasks: [
      ["Collect changes", "completed"],
      ["Draft release notes", "completed"],
      ["Review screenshots", "review"],
      ["Approve release copy", "pending"],
    ],
    journal: "Sample decision: keep release notes focused on changes people can see and use.",
    next: "The copy is drafted. Screenshot review and final approval remain open.",
  },
  {
    workspace: "Telemetry review",
    title: "Make stale sensor data visible",
    request: "Help Observatory distinguish a quiet telescope from a disconnected one.",
    summary:
      "The sample dashboard marks old readings as stale instead of treating them as current measurements.",
    points: [
      "Show the last received timestamp",
      "Use text as well as color for stale readings",
      "Keep previous readings available for comparison",
    ],
    code: "const stale = now - reading.receivedAt > MAX_READING_AGE;\nconst label = stale ? 'Awaiting telemetry' : 'Receiving telemetry';",
    tasks: [
      ["Inspect sample readings", "completed"],
      ["Add stale-state labels", "completed"],
      ["Review contrast at night", "review"],
      ["Compare reconnect behavior", "pending"],
    ],
    journal:
      "Sample decision: a stale reading remains visible with its age and a plain-language label.",
    next: "Review the night palette and the transition from stale to current telemetry.",
  },
  {
    workspace: "Observation planning",
    title: "Prepare the observing checklist",
    request:
      "Create a checklist for a fictional observing session, including weather and equipment checks.",
    summary:
      "This planning example keeps prerequisites visible and leaves the weather-dependent step blocked.",
    points: [
      "Confirm the target list",
      "Check the sample equipment inventory",
      "Wait for the weather review before scheduling",
    ],
    code: "## Session preparation\n- [x] Target list\n- [x] Equipment inventory\n- [ ] Weather review\n- [ ] Schedule session",
    tasks: [
      ["Collect target list", "completed"],
      ["Check equipment inventory", "completed"],
      ["Review weather window", "pending"],
      ["Schedule observation", "blocked"],
    ],
    journal: "Sample decision: scheduling stays blocked until the weather window is reviewed.",
    next: "No real weather service or telescope is connected. The blocked step demonstrates a prerequisite.",
  },
  {
    workspace: "Offline editing",
    title: "Keep notes during a connection loss",
    request: "Make Field Notes preserve an edit when a researcher temporarily loses connectivity.",
    summary: "The sample editor keeps a local draft and makes synchronization state explicit.",
    points: [
      "Keep the local draft",
      "Show pending synchronization",
      "Retain both versions when edits conflict",
    ],
    code: "const status = pendingEdits.length ? 'Saved on this device' : 'Synced';\nreturn <SaveStatus>{status}</SaveStatus>;",
    tasks: [
      ["Describe offline states", "completed"],
      ["Add saved-on-device copy", "completed"],
      ["Review conflict handling", "in_progress"],
      ["Review on a phone", "pending"],
    ],
    journal:
      "Sample decision: saved locally and synchronized are separate states, with separate labels.",
    next: "The active task is a simulated snapshot. Review conflict handling before phone acceptance.",
  },
  {
    workspace: "Export review",
    title: "Document the notebook export",
    request: "Write a short guide for exporting a notebook without losing attachment references.",
    summary: "This completed example includes a concise guide and a checked sample manifest.",
    points: [
      "Name each exported notebook",
      "Keep attachment paths relative",
      "Include a manifest alongside the notes",
    ],
    code: "notebook/\n  notes.md\n  manifest.json\n  attachments/\n    field-sketch.svg",
    tasks: [
      ["Outline the export guide", "completed"],
      ["Check relative attachment paths", "completed"],
      ["Review sample manifest", "completed"],
      ["Approve documentation", "completed"],
    ],
    journal:
      "Sample decision: use relative paths so the exported notebook can be moved as a folder.",
    next: "All tasks in this sample are complete. Compare its progress indicator with a workspace awaiting review.",
  },
] as const;
