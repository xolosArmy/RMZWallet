/**
 * Shared evaluation-time captured clock.
 *
 * Captures Date.now once at module evaluation to prevent load-order attacks
 * where an attacker replaces Date.now between the loading of different
 * security modules (e.g. TM1 alias verification port and publication authorizer).
 */
export const nowMs = Function.prototype.call.bind(Date.now) as () => number
export const dateNow = nowMs
