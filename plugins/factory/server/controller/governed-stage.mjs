import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function retainedStageFailure(error, cleanup) {
  return new AggregateError([error, cleanup], "Factory stage retained for recovery", {
    cause: error,
  });
}

/** One provider execution under Paseo's existing governor and native custody.
 * The controller retains this handle before calling run, so stop never depends
 * on a coding model acknowledging an interruption. Runtime classes come from
 * the same installed Paseo build that supplies store and captured client.
 */
class FactoryGovernedStage {
  constructor(options) {
    if (typeof options.QuotaSupervisor?.prototype?.complete !== "function")
      throw new Error("Factory requires the installed quota completion handoff");
    this.invocationOptions = options;
    this.optionKeys = Object.keys(options).sort();
    this.data = {};
    for (const name of ["account", "sessionConfig", "custodyOptions", "placement"]) {
      this.data[name] = structuredClone(options[name]);
    }
    this.options = { ...options, ...structuredClone(this.data) };
    this.methods = {
      execution: options.store.execution,
      transition: options.store.transition,
      finalize: options.store.finalize,
      createCustody: options.NativeCustody.create,
      readSettlement: options.NativeCustody.readSettlement,
      readOutcome: options.NativeCustody.readOutcome,
      attach: options.QuotaSupervisor.attach,
      completePrototype: options.QuotaSupervisor.prototype.complete,
      openSession: options.client.openSession,
      assertClient: options.client.assertCurrent,
      assertOwner: options.authority.assertCurrent,
      assertAuthentication: options.assertAuthentication,
      assertCapturedAuthentication: options.authentication?.assertCurrent,
      readTokens: options.authentication?.readTokens,
    };
    this.ownerEpoch = options.authority.identity.epoch;
    if (
      options.authentication &&
      options.authentication.authenticationGeneration !== options.authenticationGeneration
    )
      throw new Error("Factory stage authentication generation does not match its binding");
    Object.defineProperty(this, "executionId", { value: randomUUID(), enumerable: true });
    this.revoked = false;
    this.started = false;
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1000 ||
      this.timeoutMs >
        (options.stage === "validation" ? 2 * 60 * 60 * 1000 + 120000 : 60 * 60 * 1000)
    )
      throw new Error("Factory stage requires a bounded timeout");
  }

  assertOptions() {
    const o = this.options;
    if (!isDeepStrictEqual(Object.keys(this.invocationOptions).sort(), this.optionKeys))
      throw new Error("Factory stage invocation fields changed");
    for (const name of this.optionKeys) {
      const expected = name in this.data ? this.data[name] : o[name];
      const matches =
        name in this.data
          ? isDeepStrictEqual(this.invocationOptions[name], expected)
          : this.invocationOptions[name] === expected;
      if (!matches) throw new Error("Factory stage invocation changed");
      if (name in this.data && !isDeepStrictEqual(o[name], this.data[name]))
        throw new Error("Factory stage captured data changed");
    }
    if (o.authority.identity.epoch !== this.ownerEpoch)
      throw new Error("Factory stage owner generation changed");
    const current = {
      execution: o.store.execution,
      transition: o.store.transition,
      finalize: o.store.finalize,
      createCustody: o.NativeCustody.create,
      readSettlement: o.NativeCustody.readSettlement,
      readOutcome: o.NativeCustody.readOutcome,
      attach: o.QuotaSupervisor.attach,
      completePrototype: o.QuotaSupervisor.prototype.complete,
      openSession: o.client.openSession,
      assertClient: o.client.assertCurrent,
      assertOwner: o.authority.assertCurrent,
      assertAuthentication: o.assertAuthentication,
      assertCapturedAuthentication: o.authentication?.assertCurrent,
      readTokens: o.authentication?.readTokens,
    };
    if (!isDeepStrictEqual(current, this.methods))
      throw new Error("Factory stage native methods changed");
  }

  assertAuthority = () => {
    if (this.revoked) throw new Error("Factory stage authority is revoked");
    this.assertOptions();
    this.assertCustody?.();
    this.methods.assertOwner.call(this.options.authority);
    this.assertOptions();
    this.methods.assertClient.call(this.options.client);
    this.assertOptions();
    this.methods.assertAuthentication();
    this.assertOptions();
    if (this.options.authentication) {
      this.methods.assertCapturedAuthentication.call(this.options.authentication);
      this.assertOptions();
    }
  };

  async openSession(input) {
    try {
      return await this.methods.openSession.call(this.options.client, input);
    } catch (error) {
      if (error instanceof this.options.ConstructionCleanupError)
        this.nativeCleanup = error.retryCleanup.bind(error);
      throw error;
    }
  }

  async transition(event, observation) {
    const { store, account, reservationId } = this.options;
    const current = await this.methods.execution.call(store, account, reservationId);
    const result = await this.methods.transition.call(store, {
      account,
      reservationId,
      expectedGeneration: current.generation,
      event,
      ...(observation ? { observation } : {}),
    });
    if (result.kind !== "transitioned")
      throw new Error(`Factory quota transition held: ${result.reason}`);
    return result.execution;
  }

  async settle() {
    const { NativeCustody, authenticationGeneration } = this.options;
    if (!this.custody) throw new Error("Factory construction requires custody reconciliation");
    if (this.nativeCleanup) await this.nativeCleanup();
    if (this.child) await this.settleChild(this.child);
    // Only the native receipt establishes settlement when construction returned no child.
    await this.methods.readSettlement.call(
      NativeCustody,
      this.custodyRecord.directory,
      this.custodyRecord.identity,
    );
    return {
      executionId: this.executionId,
      authenticationGeneration,
      settlementId: this.custodyRecord.identity.nonce,
    };
  }

  stop(reason = "manual") {
    this.revoked = true;
    if (this.completed || this.executionCompleted) return Promise.resolve();
    if (this.stopping) return this.stopping;
    this.stopping = this.performStop(reason).then(() => undefined);
    return this.stopping;
  }

  async performStop(reason) {
    // Stop must observe the actual start transaction outcome. A stop during
    // telemetry or disk persistence cannot cache success before start commits.
    await this.initializing?.catch(() => undefined);
    if (this.supervisor) return this.freeze(reason);
    if (!this.started && this.startAttempted) {
      const retained = await this.methods.execution.call(
        this.options.store,
        this.options.account,
        this.options.reservationId,
      );
      if (retained.state === "reserved" && retained.executionId === null) return;
      if (retained.executionId !== this.executionId)
        throw new Error("Factory start outcome requires native reconciliation");
      this.started = true;
    }
    if (!this.started) return;
    // Persist and stop independently: failed disk writes must not keep the
    // native worker alive. An uncertain result retains the reservation.
    const results = await Promise.allSettled([
      this.transition({ type: "freeze", reason }),
      this.settle(),
    ]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    return this.transition({
      type: "settled",
      executionId: this.executionId,
      settlementId: results[1].value.settlementId,
    });
  }

  async reconcileStop() {
    if (!this.stopping) throw new Error("Factory stage has no stop to reconcile");
    await this.stopping.catch(() => undefined);
    if (this.executionCompleted) return;
    if (this.supervisor) {
      this.stopping = this.reconcileFreeze().then(() => undefined);
    } else {
      this.stopping = this.performStop("manual").then(() => undefined);
    }
    return this.stopping;
  }

  async run(prompt) {
    if (typeof prompt !== "string") throw new Error("Invalid Factory stage prompt");
    if (this.invoked) throw new Error("Factory stage cannot run twice");
    this.invoked = true;
    const o = this.options;
    const deadline = setTimeout(() => {
      this.failure = new Error("Factory stage exceeded its time limit");
      void this.stop("manual").catch((error) => {
        this.failure = error;
      });
    }, this.timeoutMs);
    deadline.unref();
    this.initializing = (async () => {
      this.assertAuthority();
      const observation = await o.readObservation();
      this.assertAuthority();
      const retained = await this.methods.execution.call(o.store, o.account, o.reservationId);
      this.assertAuthority();
      const resuming = retained.state === "frozen";
      if (resuming && o.resume !== true)
        throw new Error("Factory frozen execution requires reconciled resume");
      this.startAttempted = true;
      await this.transition(
        {
          type: resuming ? "resume" : "start",
          executionId: this.executionId,
          authenticationGeneration: o.authenticationGeneration,
          ...(resuming ? { manual: o.manualResume === true } : {}),
        },
        observation,
      );
      this.started = true;
    })();
    try {
      await this.initializing;
      this.assertAuthority();
      this.custody = await this.methods.createCustody.call(o.NativeCustody, {
        ...o.custodyOptions,
        identity: {
          executionId: this.executionId,
          authenticationGeneration: o.authenticationGeneration,
          attemptId: o.attemptId,
          ownershipGeneration: o.authority.identity.epoch,
        },
      });
      this.assertAuthority();
      const custody = this.custody;
      const custodyIdentity = structuredClone(custody.identity);
      const custodyDirectory = custody.directory;
      this.custodyRecord = { directory: custodyDirectory, identity: custodyIdentity };
      const spawn = this.custody.spawn;
      const settle = this.custody.settle;
      this.settleChild = (child) => settle.call(custody, child);
      this.assertCustody = () => {
        if (
          this.custody.directory !== custodyDirectory ||
          !isDeepStrictEqual(this.custody.identity, custodyIdentity) ||
          this.custody.spawn !== spawn ||
          this.custody.settle !== settle
        )
          throw new Error("Factory stage native custody changed");
      };
      await o.recordCustody({
        custody: this.custody,
        account: o.account,
        reservationId: o.reservationId,
        providerId: o.providerId,
        occurrenceId: o.occurrenceId,
        stage: o.stage,
        workspace: o.sessionConfig.cwd,
      });
      this.assertAuthority();
      this.session = await this.openSession({
        placement: o.placement,
        inspection: {
          executionId: this.executionId,
          title: `Factory ${o.stage}`,
          stop: () => this.stop("manual"),
          assertSettled: async () => {
            await this.methods.readSettlement.call(
              o.NativeCustody,
              custodyDirectory,
              custodyIdentity,
            );
          },
        },
        config: o.sessionConfig,
        account: o.account,
        permissionProfile: o.permissionProfile,
        ...(o.authentication
          ? {
              externalChatgptAuth: {
                assertCurrent: this.assertAuthority,
                readTokens: async (reason) => {
                  this.assertAuthority();
                  const tokens = await this.methods.readTokens.call(o.authentication, reason);
                  this.assertAuthority();
                  return tokens;
                },
              },
            }
          : {}),
        processCustody: {
          spawn: async (command, args) => {
            this.assertAuthority();
            this.assertCustody();
            let child;
            try {
              child = await spawn.call(custody, command, args);
            } catch (error) {
              if (error instanceof o.ConstructionCleanupError)
                this.nativeCleanup = error.retryCleanup.bind(error);
              throw error;
            }
            this.child = child;
            try {
              this.assertAuthority();
            } catch (error) {
              await this.settleChild(child);
              throw error;
            }
            return child;
          },
          settle: (child) => this.settleChild(child),
          readOutcome: () =>
            this.methods.readOutcome.call(o.NativeCustody, custodyDirectory, custodyIdentity),
        },
        guard: (request) => {
          this.assertAuthority();
          if (!this.supervisor) throw new Error("Factory quota supervision is not ready");
          this.assertSupervisor();
          return this.supervisor.guard(request);
        },
      });
      const session = this.session;
      const close = session.close;
      this.closeSession = () => close.call(session);
      this.assertAuthority();
      if (typeof this.session.readQuotaObservation !== "function")
        throw new Error("Factory execution lacks captured provider telemetry");
      const sessionMethods = {
        run: this.session.run,
        close: this.session.close,
        readQuotaObservation: this.session.readQuotaObservation,
      };
      this.assertSession = () => {
        for (const [name, method] of Object.entries(sessionMethods)) {
          if (this.session[name] !== method) throw new Error("Factory stage session changed");
        }
      };
      this.supervisor = await this.methods.attach.call(o.QuotaSupervisor, {
        store: o.store,
        account: o.account,
        reservationId: o.reservationId,
        executionId: this.executionId,
        authenticationGeneration: o.authenticationGeneration,
        readObservation: () => {
          this.assertSession();
          return sessionMethods.readQuotaObservation.call(this.session);
        },
        assertAuthority: this.assertAuthority,
        freezeAndSettle: () => this.settle(),
        onFailure: (error) => {
          this.failure = error;
          this.revoked = true;
        },
      });
      const supervisorMethods = {
        complete: this.supervisor.complete,
        freeze: this.supervisor.freeze,
        reconcileFreeze: this.supervisor.reconcileFreeze,
        guard: this.supervisor.guard,
        startMonitoring: this.supervisor.startMonitoring,
      };
      this.freeze = (reason) => supervisorMethods.freeze.call(this.supervisor, reason);
      this.reconcileFreeze = () => supervisorMethods.reconcileFreeze.call(this.supervisor);
      this.assertSupervisor = () => {
        for (const [name, method] of Object.entries(supervisorMethods)) {
          if (this.supervisor[name] !== method) throw new Error("Factory stage supervisor changed");
        }
      };
      this.assertAuthority();
      supervisorMethods.startMonitoring.call(this.supervisor);
      await this.transition({ type: "started", executionId: this.executionId });
      this.assertAuthority();
      this.assertSession();
      const result = await sessionMethods.run.call(this.session, prompt);
      this.assertSession();
      this.assertAuthority();
      if (result.canceled) throw new Error("Factory provider turn was cancelled");
      if (this.failure) throw this.failure;
      this.assertSupervisor();
      const completed = await supervisorMethods.complete.call(this.supervisor);
      this.executionCompleted = true;
      this.assertAuthority();
      this.assertSupervisor();
      const settlement = {
        executionId: this.executionId,
        authenticationGeneration: o.authenticationGeneration,
        settlementId: completed.settlementId,
      };
      const observation = await o.readObservation();
      this.assertAuthority();
      const finalized = await this.methods.finalize.call(o.store, {
        account: o.account,
        reservationId: o.reservationId,
        observation,
      });
      if (finalized.kind !== "finalized")
        throw new Error(`Factory finalization held: ${finalized.reason ?? finalized.kind}`);
      this.assertAuthority();
      this.completed = true;
      this.revoked = true;
      return { result, executionId: this.executionId, settlement };
    } catch (error) {
      // Preserve both the cause and any unconfirmed cleanup. Never forge a
      // termination receipt or erase this attempt because its promise rejected.
      try {
        await this.stop(this.supervisor ? "quota" : "manual");
      } catch (cleanup) {
        throw retainedStageFailure(error, cleanup);
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      if (this.closeSession) await this.closeSession();
    }
  }
}

export function createFactoryGovernedStage(options) {
  return new FactoryGovernedStage(options);
}
