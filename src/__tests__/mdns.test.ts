import { Endpoint } from "../endpoint";
import { IrohError } from "../errors";
import {
  MdnsSubscriptionController,
  mdnsSupported,
  type DiscoveryEvent,
  type MdnsSubscriptionBinding,
} from "../mdns";
import { captureRejection, createMockBinding, flush } from "./helpers";

function expectIrohError(value: unknown): IrohError {
  expect(value).toBeInstanceOf(IrohError);
  return value as IrohError;
}

/** A recording, hand-drivable {@link MdnsSubscriptionBinding}. */
function fakeMdns(): {
  binding: MdnsSubscriptionBinding;
  unsubscribes: number[];
  onStart?: (subId: number) => void;
  onEvent?: (event: string) => void;
  onClose?: (event: string) => void;
} {
  const fake: ReturnType<typeof fakeMdns> = {
    unsubscribes: [],
    binding: undefined as unknown as MdnsSubscriptionBinding,
  };
  fake.binding = {
    startSubscribe: (onStart, onEvent, onClose) => {
      fake.onStart = onStart;
      fake.onEvent = onEvent;
      fake.onClose = onClose;
    },
    unsubscribe: (subId) => {
      fake.unsubscribes.push(subId);
    },
  };
  return fake;
}

describe("mdnsSupported", () => {
  it("returns the native build's mDNS support flag", () => {
    const mock = createMockBinding();
    mock.mdnsSupportedResult = true;
    expect(mdnsSupported(mock.binding)).toBe(true);
  });

  it("is false on a build compiled without mDNS (the compiled-out path)", () => {
    const mock = createMockBinding();
    mock.mdnsSupportedResult = false;
    expect(mdnsSupported(mock.binding)).toBe(false);
  });

  it("wraps a native failure as an IrohError", () => {
    const mock = createMockBinding();
    mock.failures.mdnsSupported = new Error("[iroh:7000] boom");
    const error = expectIrohError(
      (() => {
        try {
          mdnsSupported(mock.binding);
          return undefined;
        } catch (e) {
          return e;
        }
      })(),
    );
    expect(error.kind).toBe("mdns-unavailable");
  });
});

describe("MdnsSubscriptionController", () => {
  it("parses discovered events into the events stream", async () => {
    const fake = fakeMdns();
    const sub = new MdnsSubscriptionController(fake.binding);
    fake.onStart?.(3);
    const discovered: DiscoveryEvent = {
      type: "discovered",
      endpointId: "endpoint-abc" as DiscoveryEvent["endpointId"],
      relayUrls: [],
      directAddrs: ["127.0.0.1:41234"],
    };
    fake.onEvent?.(JSON.stringify(discovered));
    const iterator = sub.events[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: discovered, done: false });
  });

  it("parses expired events into the events stream", async () => {
    const fake = fakeMdns();
    const sub = new MdnsSubscriptionController(fake.binding);
    fake.onStart?.(1);
    fake.onEvent?.(JSON.stringify({ type: "expired", endpointId: "endpoint-x" }));
    const iterator = sub.events[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      value: { type: "expired", endpointId: "endpoint-x" },
      done: false,
    });
  });

  it("resolves started once the native subscription id arrives", async () => {
    const fake = fakeMdns();
    const sub = new MdnsSubscriptionController(fake.binding);
    fake.onStart?.(9);
    await expect(sub.started).resolves.toBeUndefined();
  });

  it("unsubscribe tears the native subscription down and is idempotent", () => {
    const fake = fakeMdns();
    const sub = new MdnsSubscriptionController(fake.binding);
    fake.onStart?.(5);
    sub.unsubscribe();
    sub.unsubscribe();
    expect(fake.unsubscribes).toEqual([5]);
  });

  it("a native close before start rejects started with the typed error", async () => {
    const fake = fakeMdns();
    const sub = new MdnsSubscriptionController(fake.binding);
    fake.onClose?.("error [iroh:7000] mDNS discovery is not available in this build");
    const error = expectIrohError(await captureRejection(sub.started));
    expect(error.kind).toBe("mdns-unavailable");
  });

  it("propagates a synchronous native subscribe throw to the caller", () => {
    const failing: MdnsSubscriptionBinding = {
      startSubscribe: () => {
        throw new Error("[iroh:7000] this build was compiled without the mdns feature");
      },
      unsubscribe: () => {},
    };
    expect(() => new MdnsSubscriptionController(failing)).toThrow();
  });
});

describe("Endpoint.mdns", () => {
  it("maps discovery.mdns onto the native discoveryMdns config flag", async () => {
    const mock = createMockBinding();
    await Endpoint.create({ preset: "minimal", discovery: { mdns: true } }, mock.binding);
    expect(mock.configs.at(-1)?.discoveryMdns).toBe(true);
  });

  it("omits discoveryMdns when discovery is not requested", async () => {
    const mock = createMockBinding();
    await Endpoint.create({ preset: "minimal" }, mock.binding);
    expect(mock.configs.at(-1)?.discoveryMdns).toBeUndefined();
  });

  it("subscribe delivers events and unsubscribes on endpoint close", async () => {
    const mock = createMockBinding();
    const endpoint = await Endpoint.create({ discovery: { mdns: true } }, mock.binding);
    const sub = endpoint.mdns.subscribe();
    await sub.started;
    const call = mock.mdnsSubscribes.at(-1);
    expect(call).toBeDefined();
    call?.onEvent(
      JSON.stringify({ type: "discovered", endpointId: "peer-1", relayUrls: [], directAddrs: [] }),
    );
    const iterator = sub.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      type: "discovered",
      endpointId: "peer-1",
      relayUrls: [],
      directAddrs: [],
    });
    await endpoint.close();
    expect(mock.mdnsUnsubscribes).toContain(call?.subId);
  });

  it("subscribe throws mdns-unavailable when the native side rejects it (compiled out)", async () => {
    const mock = createMockBinding();
    mock.failures.mdnsSubscribe = new Error(
      "[iroh:7000] this build was compiled without the mdns feature",
    );
    const endpoint = await Endpoint.create({}, mock.binding);
    const error = expectIrohError(
      (() => {
        try {
          endpoint.mdns.subscribe();
          return undefined;
        } catch (e) {
          return e;
        }
      })(),
    );
    expect(error.kind).toBe("mdns-unavailable");
    await endpoint.close();
  });

  it("creating with discovery.mdns on a compiled-out build rejects with mdns-unavailable", async () => {
    const mock = createMockBinding();
    mock.failures.createEndpoint = new Error(
      "[iroh:7000] this build was compiled without the mdns feature",
    );
    const error = expectIrohError(
      await captureRejection(Endpoint.create({ discovery: { mdns: true } }, mock.binding)),
    );
    expect(error.kind).toBe("mdns-unavailable");
    await flush();
  });
});
