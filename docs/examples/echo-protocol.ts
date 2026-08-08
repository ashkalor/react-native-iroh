/**
 * echo-protocol: your own protocol over a raw QUIC stream.
 *
 * One concept: an ALPN names a protocol, and `endpoint.streams` gives you the
 * two sides of it. The server declares the ALPN at creation (iroh's router
 * fixes its ALPN set when it spawns), accepts connections, and echoes every
 * frame back; the client dials, sends, and reads the reply.
 *
 * Framing is `"framed"` by default, so one `send` arrives as exactly one chunk
 * on the other side and neither side has to reassemble a byte stream by hand.
 */
import { Endpoint, type EndpointAddr } from "react-native-iroh";

const ALPN = "example/echo/1";

/** Accepts echo connections until the endpoint is closed. */
export async function serveEcho(): Promise<EndpointAddr> {
  const endpoint = await Endpoint.create({ alpns: [ALPN] });
  const listener = endpoint.streams.listen(ALPN);

  void (async () => {
    for await (const connection of listener.connections) {
      // One connection can carry many streams; handle each independently.
      void (async () => {
        for await (const stream of connection.incoming) {
          void (async () => {
            for await (const frame of stream.data) {
              await stream.send(frame);
            }
          })();
        }
      })();
    }
  })();

  return endpoint.addr;
}

/** Dials an echo server, sends one message, and returns what came back. */
export async function echo(server: EndpointAddr, message: Uint8Array): Promise<Uint8Array> {
  await using endpoint = await Endpoint.create();
  // A full EndpointAddr works without discovery; a bare `server.id` needs the
  // "n0" preset to resolve the peer.
  const connection = await endpoint.streams.connect(server, ALPN);
  const stream = await connection.openStream();

  // The peer's `incoming` does not fire until a stream carries bytes, so the
  // send is what makes the server see this stream at all.
  await stream.send(message);
  for await (const frame of stream.data) {
    connection.close();
    return frame;
  }
  throw new Error("the server closed the stream without replying");
}
