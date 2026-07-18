/**
 * Stable iroh error codes and their kinds. This table is the single source of
 * truth for the code/kind mapping; both the {@link IrohErrorCode} and
 * {@link IrohErrorKind} unions are derived from it.
 */
const KIND_BY_CODE = {
  1000: "internal",
  1001: "invalid-handle",
  1002: "invalid-ticket",
  1003: "invalid-path",
  2000: "endpoint-bind",
  3000: "blob-import",
  3001: "blob-download",
  3002: "blob-export",
  3003: "cancelled",
} as const;

type KindByCode = typeof KIND_BY_CODE;

/** The union of stable numeric iroh error codes. */
export type IrohErrorCode = keyof KindByCode;

/** The union of human-readable iroh error kinds. */
export type IrohErrorKind = KindByCode[IrohErrorCode];

/**
 * The discriminated union of every valid `code`/`kind` pairing. Narrowing on
 * either property narrows the other, e.g. checking
 * `error.kind === "invalid-ticket"` narrows `error.code` to `1002`.
 */
export type IrohErrorCase = {
  [C in IrohErrorCode]: { readonly code: C; readonly kind: KindByCode[C] };
}[IrohErrorCode];

const ERROR_CODE_PATTERN = /\[iroh:(\d+)\]/;

function isKnownCode(code: number): code is IrohErrorCode {
  return Object.prototype.hasOwnProperty.call(KIND_BY_CODE, code);
}

/**
 * Extracts a thrown value's message and, when present, the numeric code from
 * its `[iroh:<code>]` tag.
 */
function parseIrohMessage(error: unknown): { message: string; code: number | undefined } {
  const message = error instanceof Error ? error.message : String(error);
  const match = ERROR_CODE_PATTERN.exec(message);
  return { message, code: match === null ? undefined : Number(match[1]) };
}

class IrohErrorImpl extends Error {
  readonly code: IrohErrorCode;
  readonly kind: IrohErrorKind;

  constructor(code: IrohErrorCode, message: string) {
    super(message);
    this.name = "IrohError";
    this.code = code;
    this.kind = KIND_BY_CODE[code];
  }

  static from(error: unknown): IrohError {
    if (error instanceof IrohErrorImpl) {
      return error as IrohError;
    }
    const { message, code: parsed } = parseIrohMessage(error);
    const code: IrohErrorCode = parsed !== undefined && isKnownCode(parsed) ? parsed : 1000;
    return new IrohErrorImpl(code, message) as IrohError;
  }
}

/**
 * The error type thrown (and used for Promise rejections) by every public
 * react-native-iroh API.
 *
 * - `instanceof IrohError` works and narrows `unknown` to this type.
 * - `code` and `kind` form a discriminated union ({@link IrohErrorCase}):
 *   narrowing on one narrows the other.
 * - `message` always preserves the original native message, including the
 *   `[iroh:<code>] <detail>` prefix when present.
 */
export type IrohError = IrohErrorImpl & IrohErrorCase;

interface IrohErrorConstructor {
  /** Constructs an {@link IrohError} with a known stable code. */
  new (code: IrohErrorCode, message: string): IrohError;
  readonly prototype: IrohError;
  /**
   * Converts any thrown value into an {@link IrohError}: existing instances
   * are returned as-is, native `[iroh:<code>]` messages are parsed into their
   * stable code/kind, and anything else (unknown codes, untagged errors,
   * non-Error values) maps to code `1000` / kind `"internal"` with the
   * original message preserved.
   */
  from(error: unknown): IrohError;
}

export const IrohError = IrohErrorImpl as unknown as IrohErrorConstructor;

/**
 * Extracts the stable numeric iroh error code from an error thrown (or a
 * Promise rejection produced) by the raw bridge, or `undefined` if the error
 * did not originate from the iroh bridge.
 *
 * Retained for users of the raw {@link Iroh} escape hatch; the class API
 * throws {@link IrohError}, which carries `code` and `kind` directly.
 */
export function getIrohErrorCode(error: unknown): number | undefined {
  return parseIrohMessage(error).code;
}
