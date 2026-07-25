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
config.server = { ...config.server, unstable_serverRoot: __dirname };

module.exports = config;
