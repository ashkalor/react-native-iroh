import { IrohError } from "../errors";
import { parseTicket, validateTicketShape } from "../ticket";
import type { TicketInfo } from "../ticket";
import { createMockBinding } from "./helpers";

/** Shortest valid shape: "blob" + 53 base32 chars. */
const MINIMAL_TICKET = `blob${"a".repeat(53)}`;

/** A realistic-looking ticket body (lowercase base32, well past minimum). */
const REALISTIC_TICKET = `blobqcqaynjcnm2gs4zvnrqxezlemvzgk3tumvxgc4tjnzsxg${"y3fojuw".repeat(8)}`;

function expectInvalidShape(input: string): void {
  let caught: unknown;
  try {
    validateTicketShape(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(IrohError);
  const error = caught as IrohError;
  expect(error.code).toBe(1002);
  expect(error.kind).toBe("invalid-ticket");
}

describe("validateTicketShape", () => {
  it("accepts a well-shaped ticket and returns the identical string", () => {
    expect(validateTicketShape(MINIMAL_TICKET)).toBe(MINIMAL_TICKET);
    expect(validateTicketShape(REALISTIC_TICKET)).toBe(REALISTIC_TICKET);
  });

  it("rejects strings without the blob prefix", () => {
    expectInvalidShape(`doc${"a".repeat(60)}`);
    expectInvalidShape("definitely-not-a-ticket");
    expectInvalidShape("");
  });

  it("rejects tickets shorter than the minimum encoded length", () => {
    expectInvalidShape(`blob${"a".repeat(52)}`);
  });

  it("rejects characters outside the lowercase base32 alphabet", () => {
    // 0, 1, 8, 9 are not in RFC 4648 base32; uppercase is not the wire form.
    expectInvalidShape(`blob${"a".repeat(52)}0`);
    expectInvalidShape(`blob${"a".repeat(52)}1`);
    expectInvalidShape(`blob${"A".repeat(53)}`);
    expectInvalidShape(`blob${"a".repeat(53)} `);
  });

  it("keeps long inputs out of the error message", () => {
    let message = "";
    try {
      validateTicketShape(`nope${"x".repeat(400)}`);
    } catch (error) {
      message = (error as IrohError).message;
    }
    expect(message).toContain("invalid blob ticket");
    expect(message.length).toBeLessThan(160);
  });
});

describe("parseTicket", () => {
  it("decodes a well-shaped ticket via the native binding", () => {
    const mock = createMockBinding();
    const info: TicketInfo = {
      hash: "b".repeat(64),
      format: "hashSeq",
      nodeId: "node-abc",
    };
    mock.ticketInfo = info;
    expect(parseTicket(MINIMAL_TICKET, mock.binding)).toEqual(info);
    expect(mock.parseTicketCalls).toEqual([MINIMAL_TICKET]);
  });

  it("rejects garbage before reaching native (shape prefilter)", () => {
    const mock = createMockBinding();
    let caught: unknown;
    try {
      parseTicket("not-a-ticket", mock.binding);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IrohError);
    expect((caught as IrohError).code).toBe(1002);
    // Never called native for obviously malformed input.
    expect(mock.parseTicketCalls).toEqual([]);
  });

  it("wraps a native decode failure in a typed IrohError", () => {
    const mock = createMockBinding();
    mock.failures.parseTicket = new Error("[iroh:1002] malformed ticket body");
    let caught: unknown;
    try {
      parseTicket(MINIMAL_TICKET, mock.binding);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IrohError);
    expect((caught as IrohError).code).toBe(1002);
  });
});
