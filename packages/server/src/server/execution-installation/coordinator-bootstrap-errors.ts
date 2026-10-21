export class BootstrapRequestConflict extends Error {}
export class BootstrapAuthenticationRequired extends Error {}
/** The renewal context a review derived no longer matches the Host's current
 * coordinator history; that review must be derived again before it can act. */
export class BootstrapRenewalContextChanged extends BootstrapRequestConflict {}
/** Positive busy evidence only; parsing or identity failures must never use this type. */
export class BootstrapCoordinatorBusy extends BootstrapRequestConflict {}
