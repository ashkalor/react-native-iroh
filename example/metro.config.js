const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const root = path.resolve(__dirname, "..");

/**
 * Metro configuration (Expo). `watchFolders` keeps the workspace root in scope
 * so the example resolves `react-native-iroh` straight from the library source.
 *
 * @type {import('expo/metro-config').MetroConfig}
 */
const config = getDefaultConfig(__dirname);
config.watchFolders = [root];
// Resolve URL bundle roots (e.g. the iOS host's "index") from the example dir
// rather than the workspace root that watchFolders would otherwise imply.
//
// This MUST be paired with EXPO_NO_METRO_WORKSPACE_ROOT=1 (set by the `start`
// script). Expo derives the Android dev-client's virtual entry path from its
// OWN notion of the server root, which defaults to the workspace root because
// the repo root declares `workspaces`. Override one without the other and the
// two disagree: Expo asks for "./example/index" while Metro resolves it
// against this directory, and the Android bundle fails outright.
config.server = { ...config.server, unstable_serverRoot: __dirname };

module.exports = config;
