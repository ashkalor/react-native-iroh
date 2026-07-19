/**
 * lifecycle: where an endpoint is in its life, and the two ways to end it.
 *
 * One concept: close() is one-shot - the first call decides the outcome, and
 * every later call returns the same promise. `await using` binds that close
 * to a scope so it can never be forgotten.
 */
import { Endpoint } from "react-native-iroh";

export async function explicitLifecycle(): Promise<void> {
  const endpoint = await Endpoint.create();
  console.log(endpoint.isOpen); // true

  // One-shot close: both calls share a single native shutdown.
  const first = endpoint.close();
  const second = endpoint.close();
  console.log(first === second); // true
  await first;

  console.log(endpoint.isOpen); // false
  // The id was cached at creation, so it stays readable after close.
  console.log(`closed endpoint was ${endpoint.id}`);
}

export async function scopedLifecycle(): Promise<void> {
  // `await using` disposes (closes) the endpoint when the scope exits,
  // whether it exits normally or by throwing.
  await using endpoint = await Endpoint.create();
  console.log(`scoped endpoint ${endpoint.id}`);
  // endpoint.close() runs automatically here.
}
