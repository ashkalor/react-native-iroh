import type { EndpointId } from "./endpoint";
import { IrohError } from "./errors";
import { getIroh, type IrohBinding } from "./native";

declare const NamespaceIdBrand: unique symbol;
declare const AuthorIdBrand: unique symbol;
declare const DocTicketBrand: unique symbol;

/**
 * The identifier of a document: the public key of its namespace, as 64
 * lowercase hex characters. A branded string; obtain one from
 * {@link DocsApi.create}/{@link DocsApi.list} or {@link Doc.id}.
 *
 * @see https://docs.rs/iroh-docs/0.101.0/iroh_docs/struct.NamespaceId.html
 */
export type NamespaceId = string & { readonly [NamespaceIdBrand]: "NamespaceId" };

/**
 * The identifier of a document author: the public key of an author key pair, as
 * 64 lowercase hex characters. A branded string; obtain one from
 * {@link Authors}. The matching secret key (also hex) is the whole identity and
 * is what {@link Authors.import} takes to move an author between devices.
 *
 * @see https://docs.rs/iroh-docs/0.101.0/iroh_docs/struct.AuthorId.html
 */
export type AuthorId = string & { readonly [AuthorIdBrand]: "AuthorId" };

/**
 * A token that grants access to a document and names the peers to sync it with.
 * A branded string; obtain one from {@link Doc.share} or by validating an
 * externally received string with {@link parseDocTicket}.
 *
 * @see https://docs.rs/iroh-docs/0.101.0/iroh_docs/struct.DocTicket.html
 */
export type DocTicket = string & { readonly [DocTicketBrand]: "DocTicket" };

/** The access a {@link Doc.share} ticket grants: read-only or read/write. */
export type DocShareMode = "read" | "write";

/**
 * One document entry's metadata. The value bytes live out-of-band in the blob
 * store, addressed by {@link hash}; fetch them explicitly with
 * {@link Doc.getContent} (reads never pull bytes on their own).
 */
export interface DocEntry {
  /** The id of the author that wrote this entry. */
  readonly author: AuthorId;
  /** The entry's key. */
  readonly key: string;
  /** The BLAKE3 content hash of the entry's value, 64 lowercase hex characters. */
  readonly hash: string;
  /** The value's size in bytes. */
  readonly size: number;
  /** The entry's timestamp, in microseconds since the Unix epoch. */
  readonly timestamp: number;
}

/**
 * A selector for {@link Doc.getMany} / {@link Doc.getOne}. Omit every field (or
 * pass no query) to match all entries. When both {@link keyExact} and
 * {@link keyPrefix} are set, {@link keyExact} wins.
 */
export interface DocQuery {
  /** Restrict to entries written by this author. */
  author?: AuthorId | string;
  /** Restrict to entries whose key equals this value. */
  keyExact?: string;
  /** Restrict to entries whose key starts with this value. */
  keyPrefix?: string;
}

/** The decoded fields of a {@link DocTicket}, from {@link parseDocTicket}. */
export interface DocTicketInfo {
  /** The document the ticket grants access to. */
  readonly namespace: NamespaceId;
  /** Whether the ticket grants read-only or read/write access. */
  readonly capability: DocShareMode;
  /** The ids of the peers the ticket names to sync with. */
  readonly nodeIds: EndpointId[];
}

/**
 * Document author identity: the key pairs that sign entries. Namespaced as
 * {@link DocsApi.authors}.
 *
 * @see https://docs.rs/iroh-docs/0.101.0/iroh_docs/struct.Author.html
 */
export interface Authors {
  /**
   * This node's default author, created on first use. On a persistent docs
   * store it survives restarts.
   */
  default(): Promise<AuthorId>;
  /** Creates a new author and resolves with its id. */
  create(): Promise<AuthorId>;
  /** Every author this node holds a secret key for (and can thus write as). */
  list(): Promise<AuthorId[]>;
  /**
   * Imports an author from its secret key (hex), making it usable for writes on
   * this node, and resolves with its id. This is how an author identity moves
   * between devices. Rejects with an {@link IrohError} of kind
   * `"docs-invalid-id"` if the secret is malformed.
   */
  import(secretKey: string): Promise<AuthorId>;
}

/**
 * A single document: a key/value replica whose entries carry metadata while
 * their values live out-of-band in the blob store. Obtain one from
 * {@link DocsApi.create}/{@link DocsApi.open}/{@link DocsApi.import}.
 *
 * @see https://docs.rs/iroh-docs/0.101.0/iroh_docs/api/struct.Doc.html
 */
export interface Doc {
  /** This document's {@link NamespaceId}. */
  readonly id: NamespaceId;
  /**
   * Writes `value` under `key` as `author`, storing the bytes in the blob
   * store, and resolves with the content hash (hex).
   */
  setBytes(author: AuthorId | string, key: string, value: ArrayBuffer): Promise<string>;
  /**
   * Resolves with the entry for `author` + `key`, or `null` if there is none (a
   * deleted entry reads as absent). The content hash is included; the bytes are
   * not fetched.
   */
  getExact(author: AuthorId | string, key: string): Promise<DocEntry | null>;
  /**
   * Resolves with the first entry matching `query` (all entries if omitted), or
   * `null` if none match.
   */
  getOne(query?: DocQuery): Promise<DocEntry | null>;
  /** Resolves with every entry matching `query` (all entries if omitted). */
  getMany(query?: DocQuery): Promise<DocEntry[]>;
  /**
   * Deletes every entry for `author` whose key equals `prefix` OR starts with
   * it, and resolves with the number removed.
   *
   * This is PREFIX-scoped, mirroring iroh-docs upstream, which has no
   * exact-delete primitive: `deletePrefix(author, "note")` also removes
   * `"note-draft"` and every other key that has `"note"` as a prefix. To remove
   * exactly one key, ensure no other key shares it as a prefix. Prefix-siblings
   * can be authored by remote peers (their content may not even be local), so
   * there is no safe way to delete one key while restoring the rest.
   */
  deletePrefix(author: AuthorId | string, prefix: string): Promise<number>;
  /**
   * Mints a shareable {@link DocTicket}. `mode` defaults to `"write"` (grant
   * read/write); pass `"read"` for a read-only ticket.
   */
  share(mode?: DocShareMode): Promise<DocTicket>;
  /**
   * Resolves `entry`'s content by reading its bytes out of the blob store. This
   * is the opt-in fetch: no read pulls content implicitly. Reads the shared blob
   * store directly (it is not gated on docs being enabled); rejects with an
   * {@link IrohError} of kind `"docs-invalid-id"` if `entry.hash` is malformed,
   * or `"docs"` if the content is not present in the store.
   */
  getContent(entry: DocEntry): Promise<ArrayBuffer>;
}

/**
 * The document API over an endpoint: author identity plus document CRUD.
 * Namespaced as {@link Endpoint.docs}. Available only on an endpoint created
 * with `docs: true`; every call on a docs-disabled endpoint rejects with an
 * {@link IrohError} of kind `"docs-disabled"`.
 *
 * @see https://docs.rs/iroh-docs/0.101.0/iroh_docs/
 */
export interface DocsApi {
  /** Document author identity ({@link Authors}). */
  readonly authors: Authors;
  /** Creates a new document and resolves with a handle to it. */
  create(): Promise<Doc>;
  /**
   * Opens the document `namespaceId`, or resolves with `null` if this node does
   * not have it.
   */
  open(namespaceId: NamespaceId | string): Promise<Doc | null>;
  /**
   * Imports the document named by `ticket`, registering the peers it names, and
   * resolves with a handle to it. Live sync is not started here (that arrives in
   * a later release); the document and its peers are registered so a later sync
   * can reach them. Rejects with kind `"docs-invalid-ticket"` on a malformed
   * ticket.
   */
  import(ticket: DocTicket | string): Promise<Doc>;
  /** Resolves with the {@link NamespaceId} of every document on this node. */
  list(): Promise<NamespaceId[]>;
  /** Removes a document and all its entries from this node. */
  dropDoc(namespaceId: NamespaceId | string): Promise<void>;
}

/**
 * The native docs calls a {@link DocsController} needs, injected by
 * {@link Endpoint} with the endpoint handle baked in so the controllers stay
 * testable in isolation.
 */
export interface DocsBinding {
  authorsDefault(): Promise<string>;
  authorsCreate(): Promise<string>;
  authorsList(): Promise<string>;
  authorsImport(secretKey: string): Promise<string>;
  docsCreate(): Promise<string>;
  docsOpen(namespaceId: string): Promise<boolean>;
  docsImport(ticket: string): Promise<string>;
  docsList(): Promise<string>;
  docsDrop(namespaceId: string): Promise<void>;
  docsSetBytes(
    namespaceId: string,
    authorId: string,
    key: string,
    value: ArrayBuffer,
  ): Promise<string>;
  docsGetExact(namespaceId: string, authorId: string, key: string): Promise<string>;
  docsGetMany(namespaceId: string, queryJson: string): Promise<string>;
  docsDeletePrefix(namespaceId: string, authorId: string, prefix: string): Promise<number>;
  docsShare(namespaceId: string, mode: string): Promise<string>;
  docsGetContent(hash: string): Promise<ArrayBuffer>;
}

/**
 * Wire shape of an iroh document ticket: the kind prefix `doc` followed by
 * lowercase RFC 4648 base32. A doc ticket encodes a variant tag, a capability
 * discriminator, the 32-byte namespace, and at least one peer address, so it is
 * always well over 50 base32 characters.
 */
const DOC_TICKET_SHAPE = /^doc[a-z2-7]{50,}$/;

/** Splits a native newline-joined id list, dropping empty segments. */
function splitIds(joined: string): string[] {
  return joined.split("\n").filter((line) => line.length > 0);
}

/** Serializes a {@link DocQuery} as the native selector JSON (empty for all). */
function serializeQuery(query?: DocQuery): string {
  if (query === undefined) {
    return "";
  }
  const selector: Record<string, string> = {};
  if (query.author !== undefined) {
    selector.author = query.author;
  }
  if (query.keyExact !== undefined) {
    selector.keyExact = query.keyExact;
  } else if (query.keyPrefix !== undefined) {
    selector.keyPrefix = query.keyPrefix;
  }
  return Object.keys(selector).length === 0 ? "" : JSON.stringify(selector);
}

class AuthorsController implements Authors {
  private readonly binding: DocsBinding;

  constructor(binding: DocsBinding) {
    this.binding = binding;
  }

  async default(): Promise<AuthorId> {
    try {
      return (await this.binding.authorsDefault()) as AuthorId;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async create(): Promise<AuthorId> {
    try {
      return (await this.binding.authorsCreate()) as AuthorId;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async list(): Promise<AuthorId[]> {
    try {
      return splitIds(await this.binding.authorsList()) as AuthorId[];
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async import(secretKey: string): Promise<AuthorId> {
    try {
      return (await this.binding.authorsImport(secretKey)) as AuthorId;
    } catch (error) {
      throw IrohError.from(error);
    }
  }
}

/**
 * Internal implementation of {@link Doc}. Bridges the native docs calls to the
 * typed CRUD surface, parsing the JSON entry payloads the bridge emits. Not part
 * of the public API surface.
 */
export class DocController implements Doc {
  private readonly binding: DocsBinding;
  readonly id: NamespaceId;

  constructor(binding: DocsBinding, id: NamespaceId) {
    this.binding = binding;
    this.id = id;
  }

  async setBytes(author: AuthorId | string, key: string, value: ArrayBuffer): Promise<string> {
    try {
      return await this.binding.docsSetBytes(this.id, author, key, value);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async getExact(author: AuthorId | string, key: string): Promise<DocEntry | null> {
    try {
      return parseEntry(await this.binding.docsGetExact(this.id, author, key));
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async getMany(query?: DocQuery): Promise<DocEntry[]> {
    try {
      return parseEntries(await this.binding.docsGetMany(this.id, serializeQuery(query)));
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async getOne(query?: DocQuery): Promise<DocEntry | null> {
    const entries = await this.getMany(query);
    return entries[0] ?? null;
  }

  async deletePrefix(author: AuthorId | string, prefix: string): Promise<number> {
    try {
      return await this.binding.docsDeletePrefix(this.id, author, prefix);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async share(mode: DocShareMode = "write"): Promise<DocTicket> {
    try {
      return (await this.binding.docsShare(this.id, mode)) as DocTicket;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async getContent(entry: DocEntry): Promise<ArrayBuffer> {
    try {
      return await this.binding.docsGetContent(entry.hash);
    } catch (error) {
      throw IrohError.from(error);
    }
  }
}

/**
 * Internal implementation of {@link DocsApi}. Not part of the public API
 * surface.
 */
export class DocsController implements DocsApi {
  private readonly binding: DocsBinding;
  readonly authors: Authors;

  constructor(binding: DocsBinding) {
    this.binding = binding;
    this.authors = new AuthorsController(binding);
  }

  async create(): Promise<Doc> {
    try {
      const id = (await this.binding.docsCreate()) as NamespaceId;
      return new DocController(this.binding, id);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async open(namespaceId: NamespaceId | string): Promise<Doc | null> {
    try {
      const exists = await this.binding.docsOpen(namespaceId);
      return exists ? new DocController(this.binding, namespaceId as NamespaceId) : null;
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async import(ticket: DocTicket | string): Promise<Doc> {
    try {
      const id = (await this.binding.docsImport(ticket)) as NamespaceId;
      return new DocController(this.binding, id);
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async list(): Promise<NamespaceId[]> {
    try {
      return splitIds(await this.binding.docsList()) as NamespaceId[];
    } catch (error) {
      throw IrohError.from(error);
    }
  }

  async dropDoc(namespaceId: NamespaceId | string): Promise<void> {
    try {
      await this.binding.docsDrop(namespaceId);
    } catch (error) {
      throw IrohError.from(error);
    }
  }
}

/** Parses the native `docsGetExact` payload: an entry object or `null`. */
function parseEntry(json: string): DocEntry | null {
  const value = JSON.parse(json) as DocEntry | null;
  return value;
}

/** Parses the native `docsGetMany` payload: a JSON array of entry objects. */
function parseEntries(json: string): DocEntry[] {
  return JSON.parse(json) as DocEntry[];
}

/**
 * Validates that `ticket` has the shape of an iroh document ticket and returns
 * it as a {@link DocTicket}. A cheap syntactic check (prefix, base32 charset,
 * minimum length); only the native decode ({@link parseDocTicket}) proves it
 * fully decodes. Throws an {@link IrohError} of kind `"docs-invalid-ticket"`
 * (code `6003`) on failure.
 */
export function validateDocTicketShape(ticket: string): DocTicket {
  if (!DOC_TICKET_SHAPE.test(ticket)) {
    throw new IrohError(
      6003,
      `invalid document ticket: expected "doc" followed by base32, got ${JSON.stringify(
        ticket.length > 24 ? `${ticket.slice(0, 24)}...` : ticket,
      )}`,
    );
  }
  return ticket as DocTicket;
}

/**
 * Decodes a document ticket string into its {@link DocTicketInfo} (namespace,
 * capability, peer ids). Synchronous and native-backed: a pure parse of the
 * ticket wire format with no network or store access.
 *
 * Throws an {@link IrohError} of kind `"docs-invalid-ticket"` (code `6003`) if
 * the string is not a valid document ticket.
 *
 * @param binding Advanced: an alternative native binding, primarily for tests.
 *   App code should omit it to use the real native module.
 */
export function parseDocTicket(ticket: string, binding: IrohBinding = getIroh()): DocTicketInfo {
  validateDocTicketShape(ticket);
  try {
    return JSON.parse(binding.parseDocTicket(ticket)) as DocTicketInfo;
  } catch (error) {
    throw IrohError.from(error);
  }
}
