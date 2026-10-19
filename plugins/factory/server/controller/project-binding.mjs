import { isAbsolute, normalize } from "node:path";

/** Trusted installation identity, separate from portable repository policy. */
export function createFactoryProjectGuard({ binding, repository, client, assertCurrent }) {
  if (
    !binding ||
    Object.keys(binding).sort().join(",") !== "hostId,projectId,projectRoot,repository" ||
    typeof binding.hostId !== "string" ||
    !/^srv_[a-zA-Z0-9_-]+$/.test(binding.hostId) ||
    typeof binding.projectId !== "string" ||
    !/^prj_[a-zA-Z0-9_-]+$/.test(binding.projectId) ||
    typeof binding.projectRoot !== "string" ||
    !isAbsolute(binding.projectRoot) ||
    normalize(binding.projectRoot) !== binding.projectRoot ||
    typeof repository !== "string" ||
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
    binding.repository !== repository ||
    typeof client?.getLastServerInfoMessage !== "function" ||
    typeof client?.listProjects !== "function" ||
    typeof assertCurrent !== "function"
  )
    throw new Error("Factory requires an explicit host and project binding");

  const captured = Object.freeze({ ...binding });
  const assertHost = () => {
    assertCurrent();
    if (client.getLastServerInfoMessage()?.serverId !== captured.hostId)
      throw new Error("Factory project host changed or is unavailable");
  };
  return {
    binding: captured,
    async check() {
      // A lazy startup adapter has no server identity until its first verified
      // connection. Check the actual identity after the read, never synthesize it.
      assertCurrent();
      if (client.getLastServerInfoMessage() != null) assertHost();
      // Active project listing is deliberate: an archived project must stay
      // removed. Never use directory discovery or find-or-create for recovery.
      const response = await client.listProjects();
      assertHost();
      if (response?.error || !Array.isArray(response?.projects))
        throw new Error("Factory project registry is unavailable");
      const matches = response.projects.filter(
        (project) => project.projectId === captured.projectId,
      );
      const project = matches[0];
      if (
        matches.length !== 1 ||
        project.projectKind !== "git" ||
        project.projectRootPath !== captured.projectRoot ||
        project.projectKey !== `remote:github.com/${captured.repository.toLowerCase()}` ||
        project.archivedAt != null
      )
        throw new Error("Factory project is missing, removed, or bound to another repository");
      return captured;
    },
  };
}
