// bun test preload (wired via bunfig.toml): registers happy-dom's DOM globals
// (document, window, HTMLElement, ...) so the React renderer tests in
// src/__tests__/hooks.test.tsx can mount components with @testing-library/react
// under `bun test`. The pure-logic tests do not touch these globals, so this is
// inert for them.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
