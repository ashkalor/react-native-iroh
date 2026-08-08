import type { EndpointId } from "./endpoint";
import { IrohError } from "./errors";
import { MessageQueue } from "./message-queue";
import type { StreamFraming } from "./specs/iroh.nitro";

/**
 * How many inbound connections (on a {@link StreamListener}) or peer-opened
 * streams (on a {@link Connection}) are held for a consumer that has not picked
 * them up yet. Beyond this the oldest is closed rather than kept alive
 * indefinitely; it matches the native accept backlog.
 */
export const DEFAULT_STREAM_BACKLOG = 64;

/**
 * Options shared by {@link Streams.listen} and {@link Streams.connect}.
 */
export interface StreamOptions {
  /**
   * How the byte stream is split into the chunks {@link Stream.data} yields,
   * and how {@link Stream.send} writes them. Defaults to `"framed"`.
   *
   * Both peers must choose the same mode: it is part of the protocol the ALPN
   * names, not a local preference.
   *
   * @see {@link StreamFraming}
   */
  framing?: StreamFraming;
  /**
   * How many received chunks a {@link Stream} buffers before the consumer is
   * declared too slow. Defaults to the message-queue default (1024).
   *
   * Unlike a gossip topic, overflow here is fatal: dropping a chunk would
   * silently corrupt a byte stream, so the stream fails with kind
   * `"stream-overflow"` instead. Raise this for bursty protocols, or consume
   * {@link Stream.data} promptly and do the work elsewhere.
   */
  capacity?: number;
}

/**
 * One bidirectional QUIC stream: bytes in, bytes out, closed once.
 *
 * Obtain one from {@link Connection.openStream} or {@link Connection.incoming}.
 *
 * @see https://docs.rs/iroh/1.0.3/iroh/endpoint/struct.Connection.html#method.open_bi
 */
export interface Stream {
  /**
   * An `AsyncIterable` of the chunks received on this stream, in order. Under
   * `"framed"` each chunk is exactly one peer `send`; under `"raw"` chunk
   * boundaries are whatever the network produced.
   *
   * Iteration ends when the peer finishes the stream or {@link close} is
   * called, and throws an {@link IrohError} if the stream fails (including
   * kind `"stream-overflow"` when the consumer falls too far behind; see
   * {@link StreamOptions.capacity}).
   *
   * This is ONE shared stream, not a re-iterable collection: consuming a chunk
   * removes it, two concurrent `for await` loops split the chunks between them,
   * and breaking out of a loop closes the stream.
   */
  readonly data: AsyncIterable<Uint8Array>;
  /**
   * Settles exactly once: resolves when the stream ends in an orderly way
   * (either side finished it), rejects with an {@link IrohError} if it failed.
   * Rejections are pre-observed, so watching only {@link data} raises no
   * unhandled-rejection warning.
   */
  readonly closed: Promise<void>;
  /** Whether the stream has ended (finished, failed, or closed locally). */
  readonly isClosed: boolean;
  /**
   * Writes `data` to the peer, resolving once the bytes are handed to the QUIC
   * send buffer. That is not a delivery receipt: use a reply from the peer if
   * you need one.
   *
   * Concurrent sends are serialized natively, so a `"framed"` payload is never
   * interleaved with another. Rejects with an {@link IrohError} of kind
   * `"stream-closed"` once the stream has ended, `"stream-frame-too-large"` for
   * a framed payload above 16 MiB, or `"stream-send"` if the write fails.
   */
  send(data: Uint8Array): Promise<void>;
  /**
   * Finishes this side's writes and stops reading. Idempotent. The peer sees an
   * orderly end of stream.
   */
  close(): void;
}

/**
 * One QUIC connection to a peer on a custom ALPN, carrying any number of
 * independent {@link Stream}s in both directions.
 *
 * Obtain one from {@link Streams.connect} or {@link StreamListener.connections}.
 *
 * @see https://docs.rs/iroh/1.0.3/iroh/endpoint/struct.Connection.html
 */
export interface Connection {
  /** The peer's endpoint id. */
  readonly remoteId: EndpointId;
  /** The ALPN this connection negotiated. */
  readonly alpn: string;
  /** The framing every {@link Stream} on this connection uses. */
  readonly framing: StreamFraming;
  /**
   * An `AsyncIterable` of the streams the peer opened. Ends when the connection
   * closes, and throws an {@link IrohError} if it failed. Streams left
   * unconsumed beyond {@link DEFAULT_STREAM_BACKLOG} are closed rather than
   * queued without limit.
   *
   * One shared stream, with the same single-consumer semantics as
   * {@link Stream.data}.
   */
  readonly incoming: AsyncIterable<Stream>;
  /**
   * Settles exactly once: resolves when the connection closes in an orderly way
   * (either side), rejects with an {@link IrohError} if it failed. Rejections
   * are pre-observed.
   */
  readonly closed: Promise<void>;
  /** Whether the connection has closed. */
  readonly isClosed: boolean;
  /**
   * Opens a new bidirectional {@link Stream}.
   *
   * QUIC does not announce a stream until it carries bytes, so the peer's
   * {@link incoming} does not fire until the first {@link Stream.send}. Rejects
   * with an {@link IrohError} of kind `"stream-open"`, or `"invalid-handle"`
   * once the connection is closed.
   */
  openStream(): Promise<Stream>;
  /** Closes the connection and every stream on it. Idempotent. */
  close(): void;
}

/**
 * A live listener for inbound connections on one custom ALPN. Obtain one from
 * {@link Streams.listen}.
 */
export interface StreamListener {
  /** The ALPN this listener accepts. */
  readonly alpn: string;
  /**
   * An `AsyncIterable` of accepted {@link Connection}s. Ends when the listener
   * is closed or its endpoint shuts down, and throws an {@link IrohError} if
   * the listener failed. Connections left unconsumed beyond
   * {@link DEFAULT_STREAM_BACKLOG} are closed rather than queued without limit.
   *
   * One shared stream, with the same single-consumer semantics as
   * {@link Stream.data}.
   */
  readonly connections: AsyncIterable<Connection>;
  /**
   * Stops accepting, and frees the ALPN for a later {@link Streams.listen}.
   * Idempotent.
   *
   * Deliberately not a cascade: connections already handed to you stay open and
   * are yours to close. Only ones still waiting unconsumed are closed.
   */
  close(): void;
}

/**
 * The native calls the raw-stream controllers need, injected by {@link Endpoint}
 * so they stay testable in isolation. Mirrors the native surface one to one,
 * with handles passed as arguments.
 */
export interface StreamsBinding {
  /** Starts a listener and returns its native id. */
  listen(
    alpn: string,
    onConnection: (line: string) => void,
    onClose: (event: string) => void,
  ): number;
  /** Stops a listener (idempotent natively). */
  stopListen(listenerId: number): void;
  /** Dials a peer, resolving with the new connection's native id. */
  connect(remoteAddrJson: string, alpn: string): Promise<number>;
  /** Fixes a connection's framing and starts accepting peer-opened streams. */
  subscribeConnection(
    connectionId: number,
    framing: StreamFraming,
    onStream: (streamId: number) => void,
    onClose: (event: string) => void,
  ): void;
  /** Opens a stream, resolving with its native id. */
  openStream(connectionId: number): Promise<number>;
  /** Closes a connection (idempotent natively). */
  closeConnection(connectionId: number): void;
  /** Starts reading a stream. */
  subscribeStream(
    streamId: number,
    onData: (chunk: ArrayBuffer) => void,
    onClose: (event: string) => void,
  ): void;
  /** Writes to a stream. */
  send(streamId: number, data: ArrayBuffer): Promise<void>;
  /** Closes a stream (idempotent natively). */
  closeStream(streamId: number): void;
}

/**
 * Interprets a native close event: `"end"` (or any untagged line) is an orderly
 * finish, `"error <detail>"` carries the failure. The detail keeps its
 * `[iroh:<code>]` prefix, so the resulting error is typed as precisely as a
 * rejected Promise.
 */
function parseCloseEvent(event: string): IrohError | null {
  const space = event.indexOf(" ");
  if (space === -1 || event.slice(0, space) !== "error") {
    return null;
  }
  return IrohError.from(new Error(event.slice(space + 1)));
}

/**
 * Views `data` as an `ArrayBuffer` for the bridge, copying only when it is a
 * partial view of a larger buffer (sending `buffer` directly would then send
 * the wrong bytes).
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = data;
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) {
    return buffer;
  }
  return data.slice().buffer as ArrayBuffer;
}

/**
 * A once-only settlement with its rejection pre-observed, shared by everything
 * here that exposes a terminal `closed` promise.
 *
 * Not part of the public API surface.
 */
class Settlement {
  readonly promise: Promise<void>;
  private settled = false;
  private resolveFn!: () => void;
  private rejectFn!: (error: IrohError) => void;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    this.promise.catch(() => undefined);
  }

  get isSettled(): boolean {
    return this.settled;
  }

  /** Settles once; returns whether this call was the one that settled it. */
  settle(error: IrohError | null): boolean {
    if (this.settled) {
      return false;
    }
    this.settled = true;
    if (error === null) {
      this.resolveFn();
    } else {
      this.rejectFn(error);
    }
    return true;
  }
}

/**
 * Internal implementation of {@link Stream}. Bridges the native onData/onClose
 * callbacks to a bounded {@link MessageQueue}, treating overflow as fatal
 * because a byte stream with a hole in it is worse than no stream at all.
 *
 * Not part of the public API surface.
 */
export class StreamController implements Stream {
  private readonly settlement = new Settlement();
  private readonly chunks: MessageQueue<Uint8Array>;

  constructor(
    private readonly binding: StreamsBinding,
    private readonly streamId: number,
    private readonly options: { capacity?: number; onDispose?: () => void } = {},
  ) {
    this.chunks = new MessageQueue<Uint8Array>({
      capacity: options.capacity,
      onLagged: (dropped) => {
        this.finish(new IrohError(5006, `stream consumer fell behind; ${dropped} chunks dropped`));
      },
    });
    // May throw synchronously (a stream the endpoint already tore down): let it
    // propagate to whoever asked for the stream.
    this.binding.subscribeStream(
      streamId,
      (chunk) => this.chunks.push(new Uint8Array(chunk)),
      (event) => this.finish(parseCloseEvent(event)),
    );
  }

  get data(): AsyncIterable<Uint8Array> {
    return this.chunks;
  }

  get closed(): Promise<void> {
    return this.settlement.promise;
  }

  get isClosed(): boolean {
    return this.settlement.isSettled;
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.settlement.isSettled) {
      throw new IrohError(5004, "stream is closed");
    }
    try {
      await this.binding.send(this.streamId, toArrayBuffer(data));
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  close(): void {
    this.finish(null);
  }

  /** Ends the stream exactly once, releasing the native handle with it. */
  private finish(error: IrohError | null): void {
    if (!this.settlement.settle(error)) {
      return;
    }
    this.chunks.close(error);
    try {
      this.binding.closeStream(this.streamId);
    } catch {
      // Native close is idempotent; teardown can race the endpoint closing the
      // stream out from under us, and there is nothing to recover from either way.
    }
    this.options.onDispose?.();
  }
}

/** Everything {@link ConnectionController} needs beyond its native handle. */
export interface ConnectionInit {
  remoteId: EndpointId;
  alpn: string;
  framing: StreamFraming;
  capacity?: number;
  onDispose?(): void;
}

/**
 * Internal implementation of {@link Connection}. Owns the streams it creates so
 * closing the connection releases them, and materializes each peer-opened
 * stream immediately (which starts its native read) rather than on consumption,
 * so no inbound bytes are missed.
 *
 * Not part of the public API surface.
 */
export class ConnectionController implements Connection {
  readonly remoteId: EndpointId;
  readonly alpn: string;
  readonly framing: StreamFraming;

  private readonly settlement = new Settlement();
  private readonly incomingStreams: MessageQueue<Stream>;
  private readonly openStreams = new Set<Stream>();

  constructor(
    private readonly binding: StreamsBinding,
    private readonly connectionId: number,
    private readonly init: ConnectionInit,
  ) {
    this.remoteId = init.remoteId;
    this.alpn = init.alpn;
    this.framing = init.framing;
    this.incomingStreams = new MessageQueue<Stream>({
      capacity: DEFAULT_STREAM_BACKLOG,
      onDropped: (stream) => {
        stream.close();
      },
    });
    this.binding.subscribeConnection(
      connectionId,
      init.framing,
      (streamId) => this.onPeerStream(streamId),
      (event) => this.finish(parseCloseEvent(event)),
    );
  }

  get incoming(): AsyncIterable<Stream> {
    return this.incomingStreams;
  }

  get closed(): Promise<void> {
    return this.settlement.promise;
  }

  get isClosed(): boolean {
    return this.settlement.isSettled;
  }

  async openStream(): Promise<Stream> {
    try {
      const streamId = await this.binding.openStream(this.connectionId);
      return this.adopt(streamId);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  close(): void {
    this.finish(null);
  }

  /** Wraps a native stream id, tracking it for the connection's teardown. */
  private adopt(streamId: number): Stream {
    const stream: Stream = new StreamController(this.binding, streamId, {
      capacity: this.init.capacity,
      onDispose: () => {
        this.openStreams.delete(stream);
      },
    });
    this.openStreams.add(stream);
    return stream;
  }

  /**
   * Adopting can fail when the endpoint tore the stream down between the peer
   * opening it and this callback running. Throwing here would unwind through
   * the native trampoline, which aborts the process, so the stream is dropped
   * instead.
   */
  private onPeerStream(streamId: number): void {
    let stream: Stream;
    try {
      stream = this.adopt(streamId);
    } catch {
      this.binding.closeStream(streamId);
      return;
    }
    this.incomingStreams.push(stream);
  }

  /** Ends the connection exactly once, taking its streams with it. */
  private finish(error: IrohError | null): void {
    if (!this.settlement.settle(error)) {
      return;
    }
    for (const stream of [...this.openStreams]) {
      stream.close();
    }
    this.incomingStreams.close(error);
    try {
      this.binding.closeConnection(this.connectionId);
    } catch {
      // Idempotent natively; teardown races are not recoverable here.
    }
    this.init.onDispose?.();
  }
}

/** Everything {@link StreamListenerController} needs beyond its ALPN. */
export interface StreamListenerInit {
  alpn: string;
  /** Wraps one accepted native connection; supplied by the endpoint, which
   * tracks connections so its own close can cascade through them. */
  createConnection(connectionId: number, remoteId: EndpointId): Connection;
  onDispose?(): void;
}

/**
 * Internal implementation of {@link StreamListener}.
 *
 * Not part of the public API surface.
 */
export class StreamListenerController implements StreamListener {
  readonly alpn: string;

  private readonly accepted: MessageQueue<Connection>;
  private readonly listenerId: number;
  private disposed = false;

  constructor(
    private readonly binding: StreamsBinding,
    private readonly init: StreamListenerInit,
  ) {
    this.alpn = init.alpn;
    this.accepted = new MessageQueue<Connection>({
      capacity: DEFAULT_STREAM_BACKLOG,
      onDropped: (connection) => {
        connection.close();
      },
    });
    // May throw synchronously (an undeclared ALPN, a second listener on it, a
    // stale endpoint): let it propagate to the listen() caller.
    this.listenerId = this.binding.listen(
      init.alpn,
      (line) => this.onConnection(line),
      (event) => this.finish(parseCloseEvent(event)),
    );
  }

  get connections(): AsyncIterable<Connection> {
    return this.accepted;
  }

  close(): void {
    this.finish(null);
  }

  /**
   * Wrapping can fail when the endpoint tore the connection down between the
   * accept and this callback running. Throwing here would unwind through the
   * native trampoline, which aborts the process, so the connection is closed
   * and dropped instead.
   */
  private onConnection(line: string): void {
    const space = line.indexOf(" ");
    if (space === -1) {
      return;
    }
    const connectionId = Number(line.slice(0, space));
    const remoteId = line.slice(space + 1) as EndpointId;
    let connection: Connection;
    try {
      connection = this.init.createConnection(connectionId, remoteId);
    } catch {
      this.binding.closeConnection(connectionId);
      return;
    }
    this.accepted.push(connection);
  }

  private finish(error: IrohError | null): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.binding.stopListen(this.listenerId);
    } catch {
      // Idempotent natively; teardown races are not recoverable here.
    }
    // Closes the connections still waiting unconsumed, through onDropped.
    this.accepted.close(error);
    this.init.onDispose?.();
  }
}
