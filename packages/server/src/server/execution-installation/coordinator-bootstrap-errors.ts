export class BootstrapRequestConflict extends Error {}
export class BootstrapAuthenticationRequired extends Error {}
/** Positive busy evidence only; parsing or identity failures must never use this type. */
export class BootstrapCoordinatorBusy extends BootstrapRequestConflict {}
