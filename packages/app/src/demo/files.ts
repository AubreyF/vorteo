import { DEMO_TIMESTAMP } from "./scenario";
import { DEMO_STORIES } from "./catalog";

const SOURCES = [
  {
    id: "atlas",
    name: "Atlas",
    path: "src/navigation.tsx",
    before:
      "export function NavigationItem({ selected, children }) {\n  return (\n    <button>\n      {children}\n    </button>\n  );\n}\n",
    oldLine: "    <button>",
    newLine: "    <button aria-current={selected ? 'page' : undefined}>",
  },
  {
    id: "observatory",
    name: "Observatory",
    path: "src/telemetry.ts",
    before:
      "export function readingLabel(reading, now) {\n  const maxAge = 30_000;\n  const stale = false;\n  return stale ? 'Awaiting telemetry' : 'Receiving telemetry';\n}\n",
    oldLine: "  const stale = false;",
    newLine: "  const stale = now - reading.receivedAt > maxAge;",
  },
  {
    id: "field-notes",
    name: "Field Notes",
    path: "src/save-status.ts",
    before: "export function saveStatus(pendingEdits) {\n  return 'Synced';\n}\n",
    oldLine: "  return 'Synced';",
    newLine: "  return pendingEdits.length ? 'Saved on this device' : 'Synced';",
  },
];

function sample(cwd: string) {
  return SOURCES.find(
    (source) => cwd === `/demo/${source.id}/design` || cwd === `/demo/${source.id}/release`,
  );
}

export function demoFiles(cwd: string): Record<string, string> {
  const source = sample(cwd);
  if (!source) return {};
  const story = DEMO_STORIES[SOURCES.indexOf(source) * 2 + (cwd.endsWith("/release") ? 1 : 0)];
  return {
    "README.md": `# ${source.name}\n\n${story.summary}\n\nThis workspace contains simulated data only.\n`,
    [source.path]: source.before.replace(source.oldLine, source.newLine),
    "docs/review.md": `# ${story.workspace}\n\n${story.tasks.map(([text, status]) => `- [${status === "completed" ? "x" : " "}] ${text}`).join("\n")}\n\n${story.next}\n`,
    "package.json": JSON.stringify({ name: `${source.id}-demo`, private: true }, null, 2) + "\n",
    ...(cwd.endsWith("/release")
      ? {
          "docs/release-notes.md": `# ${story.title}\n\n${story.points.map((point) => `- ${point}`).join("\n")}\n`,
        }
      : {}),
  };
}

export function demoDiff(cwd: string) {
  const source = sample(cwd);
  if (!source || cwd.endsWith("/release")) return [];
  const originalLines = source.before.trimEnd().split("\n");
  return [
    {
      path: source.path,
      isNew: false,
      isDeleted: false,
      additions: 1,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldCount: originalLines.length,
          newStart: 1,
          newCount: originalLines.length,
          lines: originalLines.flatMap((content) =>
            content === source.oldLine
              ? [
                  { type: "remove", content },
                  { type: "add", content: source.newLine },
                ]
              : [{ type: "context", content }],
          ),
        },
      ],
    },
  ];
}

export function demoFilePath(cwd: string, path: string): string {
  if (path === "." || path === cwd || path === "./") return "";
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path.replace(/^\/+/, "");
}

export function demoDirectory(cwd: string, path: string) {
  const files = demoFiles(cwd);
  const relative = demoFilePath(cwd, path);
  const prefix = relative ? `${relative.replace(/\/$/, "")}/` : "";
  const names = new Set<string>();
  return Object.keys(files).flatMap((file) => {
    if (!file.startsWith(prefix)) return [];
    const remainder = file.slice(prefix.length);
    const name = remainder.split("/")[0];
    if (names.has(name)) return [];
    names.add(name);
    return [
      {
        name,
        path: `${cwd}/${prefix}${name}`,
        kind: remainder.includes("/") ? "directory" : "file",
        size: files[file].length,
        modifiedAt: DEMO_TIMESTAMP,
      },
    ];
  });
}
