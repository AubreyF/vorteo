export interface FactoryProjectBinding {
  hostId: string;
  projectId: string;
  projectRoot: string;
  repository: string;
}

export interface FactoryProjectClient {
  getLastServerInfoMessage(): { serverId: string } | null | undefined;
  listProjects(): Promise<{
    error?: string;
    projects: Array<{
      projectId: string;
      projectKind: string;
      projectRootPath: string;
      projectKey: string;
      archivedAt?: string | null;
    }>;
  }>;
}

export function createFactoryProjectGuard(input: {
  binding: FactoryProjectBinding;
  repository: string;
  client: FactoryProjectClient;
  assertCurrent(): void;
}): {
  readonly binding: Readonly<FactoryProjectBinding>;
  check(): Promise<Readonly<FactoryProjectBinding>>;
};
