const path = require("path");
const pak = require("../package.json");

module.exports = (api) => {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          extensions: [".js", ".ts", ".json", ".jsx", ".tsx"],
          alias: {
            // Subpath exports (`react-native-iroh/hooks`) map into the library
            // source too, so the example exercises what is in `src/` rather
            // than a previously built `lib/`. Regex key: order matters, this
            // must precede the bare-name alias.
            [`^${pak.name}/(.+)$`]: path.join(__dirname, "..", "src", "\\1"),
            [pak.name]: path.join(__dirname, "..", pak.source),
          },
        },
      ],
    ],
  };
};
