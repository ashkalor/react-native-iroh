// Minimal static file server for the benchmark harness (e2e/run-bench.sh).
// Serves the harness scratch directory (plan.json) to the example app, which
// reaches it through `adb reverse tcp:<port>`. Run with: bun (or node)
// e2e/bench-server.mjs <dir> [port].
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, normalize, sep } from "node:path";

const [dir, portArg] = process.argv.slice(2);
if (!dir) {
  console.error("usage: bun e2e/bench-server.mjs <dir> [port]");
  process.exit(1);
}
const port = Number(portArg ?? "8899");

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  // Strip leading separators and any parent traversal after normalization.
  const relative = normalize(pathname)
    .split(sep)
    .filter((part) => part !== ".." && part !== "")
    .join(sep);
  readFile(join(dir, relative)).then(
    (body) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(body);
    },
    () => {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end("not found");
    },
  );
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[bench-server] serving ${dir} on port ${port}`);
});
