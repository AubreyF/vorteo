/** Identity retained by the existing Linux controller supervisor, never a worker RPC value. */
export interface ControllerOwnership {
  readonly root: string;
  readonly identity: Readonly<{
    version: 1;
    installationId: string;
    epoch: number;
    token: string;
    supervisorPid: number;
    lockDevice: number;
    lockInode: number;
  }>;
  assertCurrent(): void;
  revoke(): void;
}
