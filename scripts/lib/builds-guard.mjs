// Vorteo :: Builds is the only writer of shared state: GitHub main, web interface
// publication, Host and Dev installs, coordinator maintenance and approval decisions
// (AGENTS.md, "Builds coordinator"). publish-main, build-instance-web --destination and the
// main pre-push hook call this guard first; installation-agent.mjs keeps an inline copy because
// it is copied and run on its own. publish-instance-web.mjs stays unguarded: the coordinator
// runs it as protected tooling during installs. It prevents accidents, not abuse: every thread
// runs as the same user.
export const BUILDS_ENV = "VORTEO_BUILDS";

export function isBuildsCoordinator(env = process.env) {
  return env[BUILDS_ENV] === "1";
}

export function assertBuildsCoordinator(action, env = process.env) {
  if (isBuildsCoordinator(env)) return;
  throw new Error(
    `${action} is reserved for the Vorteo :: Builds thread, the only writer of shared state. ` +
      "Finish on your task branch and hand it to Builds instead (AGENTS.md, Builds coordinator).",
  );
}
