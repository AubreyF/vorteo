import type { Express } from "express";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import { mountClaudeOAuthConsumer } from "./claude-oauth-consumer.js";
import { mountClaudeSetupConsumer } from "./claude-setup-consumer.js";
import { mountProviderSecretsConsumer } from "./provider-secrets-consumer.js";

export interface InstallationAccountConsumerOptions {
  paseoHome: string;
  store: DaemonConfigStore;
  /** Called with the provider whose installation account credentials changed. */
  onApplied(providerId: string): void;
}

/**
 * Mounts the routes that receive installation account deliveries from the coordinator. Keeps
 * provider-specific account wiring out of the generic server bootstrap.
 */
export function mountInstallationAccountConsumers(
  app: Express,
  options: InstallationAccountConsumerOptions,
): void {
  mountClaudeSetupConsumer(app, options);
  // Inert until the installation coordinator delivers a Host-refreshed Claude sign-in.
  mountClaudeOAuthConsumer(app, options);
  mountProviderSecretsConsumer(app, options);
}
