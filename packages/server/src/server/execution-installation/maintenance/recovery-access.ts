import {
  InstallationRecoveryOriginSchema,
  type InstallationRecoveryAccessStatus,
} from "@getpaseo/protocol/installation-enrollment";

export interface RecoveryAccessObservation {
  installationId: string;
  url: string;
  observedAt: string;
}
export type RecoveryAccessReader = (signal: AbortSignal) => Promise<RecoveryAccessObservation>;

/** A timed-out collection remains the only collection until it actually settles.
 * Refreshing cannot multiply hung native inspections or accept their late proof. */
export function createRecoveryAccessStatusReader(input: {
  installationId: string;
  read: RecoveryAccessReader | undefined;
}) {
  let active: Promise<InstallationRecoveryAccessStatus> | null = null;
  const unverified = (): InstallationRecoveryAccessStatus => ({
    version: 1,
    installationId: input.installationId,
    checkedAt: new Date().toISOString(),
    status: "unverified",
    url: null,
    validUntil: null,
  });
  return (): Promise<InstallationRecoveryAccessStatus> => {
    if (active) return active;
    const read = input.read;
    if (!read) return Promise.resolve(unverified());
    const controller = new AbortController();
    const expiresAt = Date.now() + 10_000;
    // Select the Node overload even when client ambient timer types are present.
    const scheduleTimeout: (callback: () => void, delay: number) => NodeJS.Timeout = setTimeout;
    let timer: ReturnType<typeof scheduleTimeout>;
    const inspection = Promise.resolve().then(() => read(controller.signal));
    const timeout = new Promise<null>((resolve) => {
      timer = scheduleTimeout(() => {
        controller.abort();
        resolve(null);
      }, 10_000);
      timer.unref();
    });
    const result = Promise.race([inspection, timeout])
      .then((observation): InstallationRecoveryAccessStatus => {
        const now = Date.now();
        if (!observation || controller.signal.aborted || now >= expiresAt) return unverified();
        const observedAt = Date.parse(observation.observedAt);
        const age = now - observedAt;
        const url = InstallationRecoveryOriginSchema.safeParse(observation.url);
        if (
          observation.installationId !== input.installationId ||
          !url.success ||
          !Number.isFinite(age) ||
          age < 0 ||
          age >= 30_000
        )
          return unverified();
        return {
          version: 1,
          installationId: input.installationId,
          checkedAt: new Date(now).toISOString(),
          status: "verified",
          url: url.data,
          validUntil: new Date(observedAt + 30_000).toISOString(),
        };
      })
      .catch(unverified)
      .finally(() => {
        clearTimeout(timer);
        controller.abort();
      });
    active = result;
    void Promise.allSettled([inspection, result]).then(() => {
      if (active === result) active = null;
      return undefined;
    });
    return result;
  };
}
