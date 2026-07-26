/**
 * Small shared helpers for the React hooks layer. Not part of the public API
 * surface: the hooks re-export only their public functions and result types.
 */

/**
 * Default cap on how many gossip messages (and neighbor events) a
 * {@link useGossip} subscription retains in component state. Older entries are
 * dropped once the cap is exceeded so a long-lived, chatty topic cannot grow
 * the retained arrays without bound.
 */
export const DEFAULT_RETAINED = 500;

/**
 * Appends `item` to `prev`, returning a new array capped at `max` entries by
 * dropping the oldest. Always returns a fresh array (never mutates `prev`) so
 * React sees a new reference and re-renders.
 */
export function appendCapped<T>(prev: readonly T[], item: T, max: number): T[] {
  const start = prev.length >= max ? prev.length - max + 1 : 0;
  const next = prev.slice(start);
  next.push(item);
  return next;
}

/**
 * Normalizes an unknown thrown value to an `Error`. Library APIs reject with
 * `IrohError` (an `Error` subclass), which passes through unchanged; anything
 * else is wrapped so hook consumers always read a real `Error`.
 */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
