/**
 * @format
 */

import { registerRootComponent } from "expo";
import { AppRegistry } from "react-native";
import App from "./App";
import { name as appName } from "./app.json";

// registerRootComponent registers the app as "main" (the name the iOS host and
// the Expo virtual metro entry use). The Android MainActivity starts the
// "IrohExample" component name, so register that too.
registerRootComponent(App);
AppRegistry.registerComponent(appName, () => App);
