// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-projects";
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
