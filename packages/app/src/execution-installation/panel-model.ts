import type { ProfileSharingStatus, RestartJob } from "@getpaseo/protocol/execution-installation";
import { OwnerAccessExpired, type InstallationClient } from "./client";

interface InstallationPanelState {
  initialized: boolean;
  lastUpdatedAt: string | null;
  visible: boolean;
  unlocked: boolean;
  busy: boolean;
  password: string;
  error: string | null;
  notice: string | null;
  jobs: RestartJob[];
  pendingJobs: RestartJob[];
  profileSharing: ProfileSharingStatus | null;
  passwordFile: string | null;
  sessionsSupported: boolean;
}

export class InstallationPanelModel {
  private state: InstallationPanelState = {
    initialized: false,
    lastUpdatedAt: null,
    visible: true,
    unlocked: false,
    busy: false,
    password: "",
    error: null,
    notice: null,
    jobs: [],
    pendingJobs: [],
    profileSharing: null,
    passwordFile: null,
    sessionsSupported: false,
  };
  private listeners = new Set<() => void>();
  private refreshing = false;
  private initialized = false;
  private accessGeneration = 0;

  constructor(
    private readonly client: Pick<
      InstallationClient,
      | "unlock"
      | "listRestarts"
      | "decide"
      | "profileSharingStatus"
      | "resolveProfileConflict"
      | "restoreSession"
      | "lock"
      | "passwordFile"
      | "sessionsSupported"
    >,
    private readonly options: { connectionsRegistered: boolean; openRequested?: boolean } = {
      connectionsRegistered: false,
    },
  ) {
    this.state.visible = Boolean(options.openRequested) || !options.connectionsRegistered;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.publish({ busy: true });
    try {
      const unlocked = await this.client.restoreSession();
      this.publish({
        unlocked,
        passwordFile: this.client.passwordFile,
        sessionsSupported: this.client.sessionsSupported,
        ...(unlocked ? { visible: Boolean(this.options.openRequested) } : {}),
      });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false, initialized: true });
    }
  }

  async lock(): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null, notice: null });
    try {
      await this.client.lock();
      this.accessGeneration++;
      this.publish({
        unlocked: false,
        lastUpdatedAt: null,
        password: "",
        jobs: [],
        pendingJobs: [],
        profileSharing: null,
      });
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  getState = (): InstallationPanelState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  open(): void {
    this.publish({ visible: true });
  }
  close(): void {
    if (!this.state.busy) this.publish({ visible: false });
  }
  setPassword(password: string): void {
    this.publish({ password });
  }

  async unlock(): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null, notice: null });
    try {
      await this.client.unlock(this.state.password);
      this.publish({ unlocked: true, password: "", visible: false });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  async refresh(): Promise<void> {
    if (!this.state.unlocked || this.refreshing) return;
    this.refreshing = true;
    const generation = this.accessGeneration;
    try {
      const [jobs, profileSharing] = await Promise.all([
        this.client.listRestarts(),
        this.client.profileSharingStatus(),
      ]);
      if (generation !== this.accessGeneration) return;
      const targets = new Set<RestartJob["target"]>();
      const pending = jobs.toReversed().filter((job) => {
        if (job.status !== "pending" || Date.parse(job.expiresAt) <= Date.now()) return false;
        if (targets.has(job.target)) return false;
        targets.add(job.target);
        return true;
      });
      this.publish({
        jobs,
        pendingJobs: pending,
        profileSharing,
        lastUpdatedAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      this.fail(error);
    } finally {
      this.refreshing = false;
    }
  }

  async decide(job: RestartJob, decision: "approve" | "reject"): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null, notice: null });
    try {
      await this.client.decide(job, decision);
      const notice =
        decision === "approve"
          ? "Restart approved. Its progress is shown here."
          : "Restart request rejected.";
      this.publish({ notice });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  async resolveProfileConflict(serverId: string, choice: "shared" | "environment"): Promise<void> {
    const snapshot = this.state.profileSharing;
    if (this.state.busy || !snapshot) return;
    this.publish({ busy: true, error: null, notice: null });
    try {
      await this.client.resolveProfileConflict({
        serverId,
        expectedRevision: snapshot.revision,
        choice,
      });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  private fail(error: unknown): void {
    if (error instanceof OwnerAccessExpired)
      this.publish({
        unlocked: false,
        lastUpdatedAt: null,
        password: "",
        jobs: [],
        pendingJobs: [],
        profileSharing: null,
      });
    this.publish({ error: error instanceof Error ? error.message : "Installation request failed" });
  }
  private publish(update: Partial<InstallationPanelState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
}
