import { DEMO_STORIES } from "./catalog";
import {
  AgentSnapshotPayloadSchema,
  AgentTimelineEntryPayloadSchema,
  ProjectPlacementPayloadSchema,
  WorkspaceDescriptorPayloadSchema,
  WorkspaceProjectDescriptorPayloadSchema,
} from "@getpaseo/protocol/messages";

export const DEMO_SERVER_ID = "vorteo-demo";
export const DEMO_TIMESTAMP = "2026-10-01T12:00:00.000Z";

const PROJECTS = [
  { id: "atlas", name: "Atlas", description: "A travel planner with accessible maps." },
  {
    id: "observatory",
    name: "Observatory",
    description: "A dashboard for a small telescope network.",
  },
  { id: "field-notes", name: "Field Notes", description: "An offline notebook for researchers." },
];

/** Fresh, deterministic data for every demo session. No paths identify real files. */
/** Representative progress: alternate stories show check-based and estimated progress. */
function demoTaskProgress(status: string, storyIndex: number) {
  if (status !== "in_progress" && status !== "blocked") return {};
  if (storyIndex % 2 === 0) {
    return {
      progress: 65,
      checks: [
        { text: "Behavior covered by tests", done: true },
        { text: "Reviewed on desktop and mobile", done: true },
        { text: "Owner approved the result", done: false },
      ],
    };
  }
  return { progress: status === "blocked" ? 40 : 50 };
}

export function createDemoScenario() {
  const projects = PROJECTS.map((project) =>
    WorkspaceProjectDescriptorPayloadSchema.parse({
      projectId: `demo-project-${project.id}`,
      projectKey: `demo-project-${project.id}`,
      projectDisplayName: project.name,
      projectRootPath: `/demo/${project.id}`,
      projectKind: "git",
    }),
  );
  const workspaces = projects.flatMap((project, projectIndex) =>
    [0, 1].map((index) => {
      const story = DEMO_STORIES[projectIndex * 2 + index];
      const title = story.workspace;
      const cwd = `${project.projectRootPath}/${index === 0 ? "design" : "release"}`;
      const branch =
        index === 0
          ? `feature/${["accessible-navigation", "stale-telemetry", "offline-drafts"][projectIndex]}`
          : "release/next";
      const placement = ProjectPlacementPayloadSchema.parse({
        projectKey: project.projectKey,
        projectName: project.projectDisplayName,
        workspaceName: title,
        checkout: {
          cwd,
          isGit: true,
          currentBranch: branch,
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
        },
      });
      return WorkspaceDescriptorPayloadSchema.parse({
        id: `demo-workspace-${projectIndex}-${index}`,
        projectId: project.projectId,
        projectDisplayName: project.projectDisplayName,
        projectRootPath: project.projectRootPath,
        workspaceDirectory: cwd,
        projectKind: "git",
        workspaceKind: "local_checkout",
        name: title,
        title,
        status: story.tasks.every((task) => task[1] === "completed") ? "done" : "attention",
        activityAt: DEMO_TIMESTAMP,
        diffStat: index === 0 ? { additions: 1, deletions: 1 } : { additions: 0, deletions: 0 },
        project: placement,
        gitRuntime: {
          currentBranch: branch,
          isDirty: index === 0,
          aheadBehind: { ahead: 2, behind: 0 },
        },
      });
    }),
  );
  const agents = workspaces.map((workspace, index) =>
    AgentSnapshotPayloadSchema.parse({
      id: `demo-agent-${index}`,
      provider: "demo",
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.id,
      model: "simulated",
      createdAt: DEMO_TIMESTAMP,
      updatedAt: DEMO_TIMESTAMP,
      lastUserMessageAt: DEMO_TIMESTAMP,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: false,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: DEMO_STORIES[index].title,
      requiresAttention: DEMO_STORIES[index].tasks.some((task) => task[1] === "review"),
      attentionReason: index % 2 === 0 ? "finished" : null,
      tasks: DEMO_STORIES[index].tasks.map(([text, status], taskIndex) => ({
        id: `demo-task-${index}-${taskIndex + 1}`,
        text,
        status,
        completed: status === "completed",
        source: "vorteo",
        description:
          status === "blocked"
            ? "A prerequisite remains open in this simulated project."
            : undefined,
        ...demoTaskProgress(status, index),
      })),
      journal: [
        {
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          sequence: 1,
          timestamp: DEMO_TIMESTAMP,
          text: DEMO_STORIES[index].journal,
        },
      ],
    }),
  );
  const timelines = new Map(
    agents.map((agent, index) => {
      const story = DEMO_STORIES[index];
      const messages = [
        { type: "user_message", text: story.request },
        {
          type: "assistant_message",
          text: `${story.summary}\n\n### Changes ready for review\n\n${story.points.map((point) => `- ${point}`).join("\n")}\n\n\`\`\`\n${story.code}\n\`\`\`\n\nThese projects, tasks and conversations are simulated. Open **Files** and **Changes** to inspect the sample workspace.`,
        },
        { type: "user_message", text: "Show me what remains." },
        {
          type: "assistant_message",
          text: `${story.next} You can explore themes, resize panels and inspect sample data without connecting an account.`,
        },
      ];
      const entries = messages.map((item, ordinal) =>
        AgentTimelineEntryPayloadSchema.parse({
          provider: "demo",
          item,
          timestamp: DEMO_TIMESTAMP,
          seqStart: ordinal + 1,
          seqEnd: ordinal + 1,
          sourceSeqRanges: [{ startSeq: ordinal + 1, endSeq: ordinal + 1 }],
          collapsed: [],
        }),
      );
      return [agent.id, entries] as const;
    }),
  );
  return { projects, workspaces, agents, timelines };
}
