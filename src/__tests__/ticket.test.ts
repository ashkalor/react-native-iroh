import { IrohError } from "../errors";
import { parseTicket } from "../ticket";

/** Shortest valid shape: "blob" + 53 base32 chars. */
const MINIMAL_TICKET = `blob${"a".repeat(53)}`;

/** A realistic-looking ticket body (lowercase base32, well past minimum). */
const REALISTIC_TICKET = `blobqcqaynjcnm2gs4zvnrqxezlemvzgk3tumvxgc4tjnzsxg${"y3fojuw".repeat(8)}`;

function expectInvalidTicket(input: string): void {
  let caught: unknown;
  try {
    parseTicket(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrohError);
  const error = caught as IrohError;
  expect(error.code).toBe(1002);
  expect(error.kind).toBe("invalid-ticket");
}

describe("parseTicket", () => {
  it("accepts a well-shaped ticket and returns the identical string", () => {
    expect(parseTicket(MINIMAL_TICKET)).toBe(MINIMAL_TICKET);
    expect(parseTicket(REALISTIC_TICKET)).toBe(REALISTIC_TICKET);
  });

  it("rejects strings without the blob prefix", () => {
    expectInvalidTicket(`doc${"a".repeat(60)}`);
    expectInvalidTicket("definitely-not-a-ticket");
    expectInvalidTicket("");
  });

  it("rejects tickets shorter than the minimum encoded length", () => {
    expectInvalidTicket(`blob${"a".repeat(52)}`);
  });

  it("rejects characters outside the lowercase base32 alphabet", () => {
    // 0, 1, 8, 9 are not in RFC 4648 base32; uppercase is not the wire form.
    expectInvalidTicket(`blob${"a".repeat(52)}0`);
    expectInvalidTicket(`blob${"a".repeat(52)}1`);
    expectInvalidTicket(`blob${"A".repeat(53)}`);
    expectInvalidTicket(`blob${"a".repeat(53)} `);
  });

  it("keeps long inputs out of the error message", () => {
    let message = "";
    try {
      parseTicket(`nope${"x".repeat(400)}`);
    } catch (error) {
      message = (error as IrohError).message;
    }
    expect(message).toContain("invalid blob ticket");
    expect(message.length).toBeLessThan(160);
  });
});
