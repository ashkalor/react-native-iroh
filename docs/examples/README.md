# Examples

A ladder from "hello" to real error handling. Each file teaches exactly one
concept, in order; read them top to bottom and you have the whole v0.1 API.

Every example is compiled by `bun run typecheck` against the real package
surface (the `react-native-iroh` import resolves to `src/`), so they cannot
drift. They live in the repository only and are not shipped in the npm
package.

| Step | File                                             | Teaches                                                         |
| ---- | ------------------------------------------------ | --------------------------------------------------------------- |
| 1    | [hello-endpoint.ts](./hello-endpoint.ts)         | Create an endpoint, read its `id`, close it                     |
| 2    | [lifecycle.ts](./lifecycle.ts)                   | `isOpen`, one-shot `close()`, automatic close via `await using` |
| 3    | [share-file.ts](./share-file.ts)                 | `blobs.share`: import a file, get a `BlobTicket`                |
| 4    | [download-progress.tsx](./download-progress.tsx) | `blobs.download` + `for await` progress in a React Native UI    |
| 5    | [cancel-and-errors.ts](./cancel-and-errors.ts)   | Cancelling transfers and narrowing `IrohError` kinds            |

## Roadmap slots

Planned rungs, named now so links stay stable. None of these exist yet.

- `echo-protocol` - accept a custom ALPN protocol on the endpoint's router
  (requires v0.2 surface).
- `collections` - share a set of files under a single ticket via iroh-blobs
  hash sequences (requires v0.2 surface).
- `gossip-chat` - a tiny chat room over iroh-gossip broadcast overlays
  (requires v0.2 surface).
