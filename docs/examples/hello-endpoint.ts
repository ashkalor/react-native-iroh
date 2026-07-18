/**
 * hello-endpoint: the smallest possible iroh program.
 *
 * One concept: an Endpoint is an iroh node running inside your app. Creating
 * one binds sockets and gives you an id - the public key any device on the
 * planet can use to dial you. Close it when you are done.
 */
import { Endpoint } from "react-native-iroh";

export async function helloEndpoint(): Promise<void> {
  const endpoint = await Endpoint.create();
  console.log(`hello, I am ${endpoint.id}`);
  await endpoint.close();
}
