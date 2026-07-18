/**
 * The version of the iroh Rust crate compiled into this package's native
 * library. Useful for support tickets and interop debugging: peers on the
 * same iroh major version speak the same wire protocols.
 *
 * A unit test asserts this constant matches the exact version pinned in the
 * crate manifest, so it cannot drift silently.
 *
 * @see https://docs.rs/iroh/1.0.2/iroh/
 */
export const IROH_VERSION = "1.0.2";
