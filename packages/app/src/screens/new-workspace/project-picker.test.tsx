// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  hostProjectFromRoute,
  resolveRoutedHostProject,
  type HostProjectListItem,
} from "@/projects/host-projects";
import { useNewWorkspaceProjectPicker } from "./project-picker";

function project(input: {
  viewKey: string;
  projectKey: string | null;
  projectId: string;
  projectName: string;
}): HostProjectListItem {
  return {
    ...input,
    projectKind: "git",
    iconWorkingDir: `/work/${input.projectId}`,
    hosts: [
      {
        serverId: "host",
        projectId: input.projectId,
        iconWorkingDir: `/work/${input.projectId}`,
        worktreeSupport: "supported",
      },
    ],
    workspaceKeys: [],
  };
}

describe("useNewWorkspaceProjectPicker", () => {
  it("lists projects without a Host placement and preserves the chosen project", () => {
    const local = project({
      viewKey: "local",
      projectKey: null,
      projectId: "local",
      projectName: "Local",
    });
    const remote = {
      ...project({
        viewKey: "remote",
        projectKey: null,
        projectId: "remote",
        projectName: "Remote",
      }),
      hosts: [
        {
          serverId: "dev",
          projectId: "remote",
          iconWorkingDir: "/dev/remote",
          worktreeSupport: "supported" as const,
        },
      ],
    };
    const projects = [local, remote];
    const { result } = renderHook(() =>
      useNewWorkspaceProjectPicker({
        selectedServerId: "host",
        projects,
        routeProject: null,
        routeProjectContextViewKey: null,
        lastActiveProject: null,
        allowAllProjects: true,
      }),
    );
    expect(result.current.projectPickerOptions.map((option) => option.label)).toEqual([
      "Local",
      "Remote",
    ]);
    act(() => result.current.handleSelectProjectOption("project:remote"));
    expect(result.current.selectedProject?.viewKey).toBe("remote");
    expect(result.current.selectedSourceDirectory).toBeNull();
  });

  it("keeps a logical project distinct from another project using the same Host directory", () => {
    const aubos = project({
      viewKey: "aubos",
      projectKey: null,
      projectId: "shared-directory",
      projectName: "AubOS",
    });
    const vorteo = {
      ...aubos,
      viewKey: "vorteo",
      projectName: "Vorteo",
      membership: { key: "vorteo", name: "Vorteo" },
    };
    const { result, rerender } = renderHook(
      ({ projects }) =>
        useNewWorkspaceProjectPicker({
          selectedServerId: "host",
          projects,
          routeProject: null,
          routeProjectContextViewKey: null,
          lastActiveProject: aubos,
          allowAllProjects: true,
        }),
      { initialProps: { projects: [aubos, vorteo] } },
    );
    act(() => result.current.handleSelectProjectOption("project:vorteo"));
    expect(result.current.selectedProject?.viewKey).toBe("vorteo");
    rerender({ projects: [{ ...aubos }, { ...vorteo }] });
    expect(result.current.selectedProject?.membership).toEqual(vorteo.membership);
    expect(result.current.selectedProjectOptionId).toBe("project:vorteo");
  });

  it("preserves a manual choice when the routed project hydrates", () => {
    const routePlacement = project({
      viewKey: '["host","route-local"]',
      projectKey: null,
      projectId: "route-local",
      projectName: "Route project",
    });
    const hydratedRouteProject = project({
      viewKey: "remote:github.com/acme/route",
      projectKey: "remote:github.com/acme/route",
      projectId: "route-local",
      projectName: "Route project",
    });
    const manualProject = project({
      viewKey: "remote:github.com/acme/manual",
      projectKey: "remote:github.com/acme/manual",
      projectId: "manual-local",
      projectName: "Manual project",
    });
    const { result, rerender } = renderHook(
      ({ routeProject, projects }) =>
        useNewWorkspaceProjectPicker({
          selectedServerId: "host",
          projects,
          routeProject,
          routeProjectContextViewKey: routePlacement.viewKey,
          lastActiveProject: null,
          allowAllProjects: true,
        }),
      {
        initialProps: {
          routeProject: routePlacement,
          projects: [routePlacement, manualProject],
        },
      },
    );

    const manualOption = result.current.projectPickerOptions.find(
      (option) => option.label === manualProject.projectName,
    );
    expect(manualOption).toBeDefined();
    act(() => result.current.handleSelectProjectOption(manualOption!.id));
    expect(result.current.selectedProject).toEqual(manualProject);

    rerender({
      routeProject: hydratedRouteProject,
      projects: [hydratedRouteProject, manualProject],
    });

    expect(result.current.selectedProject).toEqual(manualProject);
  });
});

describe("when nothing remembered can be used", () => {
  const first = project({
    viewKey: "first",
    projectKey: null,
    projectId: "first",
    projectName: "First",
  });
  const chosen = project({
    viewKey: "chosen",
    projectKey: null,
    projectId: "chosen",
    projectName: "Chosen",
  });

  it("falls back to the last project chosen by hand", () => {
    const { result } = renderHook(() =>
      useNewWorkspaceProjectPicker({
        selectedServerId: "host",
        projects: [first, chosen],
        routeProject: null,
        routeProjectContextViewKey: null,
        lastActiveProject: null,
        lastManualProjectViewKey: "chosen",
        allowAllProjects: true,
      }),
    );
    expect(result.current.projectTriggerLabel).toBe("Chosen");
  });

  it("asks instead of picking the first project in the list", () => {
    const { result } = renderHook(() =>
      useNewWorkspaceProjectPicker({
        selectedServerId: "host",
        projects: [first, chosen],
        routeProject: null,
        routeProjectContextViewKey: null,
        lastActiveProject: null,
        lastManualProjectViewKey: "gone",
        allowAllProjects: true,
      }),
    );
    expect(result.current.selectedProject).toBeNull();
    expect(result.current.projectTriggerLabel).toBe("Choose project");
    expect(result.current.selectedSourceDirectory).toBeNull();
  });

  it("remembers a manual choice", () => {
    const remembered: string[] = [];
    const { result } = renderHook(() =>
      useNewWorkspaceProjectPicker({
        selectedServerId: "host",
        projects: [first, chosen],
        routeProject: null,
        routeProjectContextViewKey: null,
        lastActiveProject: null,
        onManualProjectSelected: (viewKey) => remembered.push(viewKey),
        allowAllProjects: true,
      }),
    );
    act(() => result.current.handleSelectProjectOption("project:chosen"));
    expect(remembered).toEqual(["chosen"]);
  });
});

describe("shared project groups", () => {
  const vorteoMembership = { key: "remote:github.com/acme/vorteo", name: "Vorteo" };
  // A group listed ahead of Vorteo whose Host placement is the same local project.
  const miscDev = project({
    viewKey: "misc-dev",
    projectKey: null,
    projectId: "local-dev",
    projectName: "Misc Dev",
  });
  const aubos = project({
    viewKey: "aubos",
    projectKey: null,
    projectId: "shared-directory",
    projectName: "AubOS",
  });
  // Vorteo's workspaces on this Host span two local projects, so the group has no Host
  // placement of its own; it is only placed on another machine.
  const vorteo: HostProjectListItem = {
    ...project({
      viewKey: vorteoMembership.key,
      projectKey: vorteoMembership.key,
      projectId: "remote-vorteo",
      projectName: "Vorteo",
    }),
    membership: vorteoMembership,
    hosts: [
      {
        serverId: "other-mac",
        projectId: "remote-vorteo",
        iconWorkingDir: "/elsewhere/vorteo",
        worktreeSupport: "supported",
      },
    ],
  };
  // What the New workspace page derives from a Vorteo workspace stored in a local project.
  function vorteoWorkspaceIn(placement: HostProjectListItem): HostProjectListItem {
    return {
      ...placement,
      viewKey: vorteoMembership.key,
      projectName: "Vorteo",
      membership: vorteoMembership,
    };
  }

  function renderPicker(input: {
    routeProject?: HostProjectListItem | null;
    lastActiveProject?: HostProjectListItem | null;
  }) {
    return renderHook(() =>
      useNewWorkspaceProjectPicker({
        selectedServerId: "host",
        projects: [miscDev, vorteo, aubos],
        routeProject: input.routeProject ?? null,
        routeProjectContextViewKey: input.routeProject?.viewKey ?? null,
        lastActiveProject: input.lastActiveProject ?? null,
        allowAllProjects: true,
      }),
    );
  }

  it("keeps the remembered group instead of another group sharing its local project", () => {
    const { result } = renderPicker({ lastActiveProject: vorteoWorkspaceIn(miscDev) });

    expect(result.current.projectTriggerLabel).toBe("Vorteo");
    expect(result.current.selectedProjectOptionId).toBe(`project:${vorteoMembership.key}`);
    expect(result.current.selectedProject?.membership).toEqual(vorteoMembership);
    // Without its own Host placement, the group creates where the remembered workspace lives.
    expect(result.current.selectedSourceDirectory).toBe("/work/local-dev");
  });

  it("does not turn a remembered group into the native project it is stored in", () => {
    const { result } = renderPicker({ lastActiveProject: vorteoWorkspaceIn(aubos) });

    expect(result.current.projectTriggerLabel).toBe("Vorteo");
    expect(result.current.selectedProject?.membership).toEqual(vorteoMembership);
    expect(result.current.selectedSourceDirectory).toBe("/work/shared-directory");
  });

  it("selects the group whose sidebar plus opened the page", () => {
    // The plus routes to a local project AubOS also uses; the row key says which row it was.
    const routeProject = resolveRoutedHostProject({
      projectViewKey: vorteoMembership.key,
      placement: hostProjectFromRoute({
        serverId: "host",
        projectId: "shared-directory",
        sourceDirectory: "/work/shared-directory",
        displayName: "Vorteo",
      }),
      projects: [miscDev, vorteo, aubos],
      serverId: "host",
    });
    const { result } = renderPicker({ routeProject, lastActiveProject: miscDev });

    expect(result.current.projectTriggerLabel).toBe("Vorteo");
    expect(result.current.selectedProject?.membership).toEqual(vorteoMembership);
    expect(result.current.selectedSourceDirectory).toBe("/work/shared-directory");
  });
});
