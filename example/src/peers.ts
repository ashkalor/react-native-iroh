import type { EndpointAddr, EndpointId } from "react-native-iroh";

/**
 * Parses whatever the other device handed over: either a bare endpoint id, or a
 * full `EndpointAddr` JSON object.
 *
 * An id on its own is enough whenever the endpoint has discovery, which the
 * `"n0"` preset this app uses does: it publishes its own addresses to n0's DNS
 * and resolves other endpoints' the same way, so the peer only needs to know
 * WHO to look for. The full address is the fallback for endpoints with no
 * discovery (the `"minimal"` preset), where the addresses have to travel with
 * the id because nothing can look them up.
 *
 * Either form can arrive lossily: selecting wrapped text, or a QR payload that
 * was line-wrapped before encoding, routinely injects line breaks. A raw control
 * character inside a JSON string is a parse error, and none of these fields can
 * legitimately contain one, so they are stripped first.
 */
export function parseBootstrapPeer(pasted: string): EndpointAddr {
  const cleaned = [...pasted]
    .filter((character) => character.charCodeAt(0) > 0x1f)
    .join("")
    .trim();
  if (!cleaned.startsWith("{")) {
    if (!/^[0-9a-z]{52,64}$/i.test(cleaned)) {
      throw new Error(`"${cleaned.slice(0, 24)}..." is not an endpoint id`);
    }
    return { id: cleaned as EndpointId, relayUrls: [], directAddrs: [] };
  }
  try {
    return JSON.parse(cleaned) as EndpointAddr;
  } catch {
    throw new Error("bootstrap peer is neither an endpoint id nor a full address object");
  }
}
