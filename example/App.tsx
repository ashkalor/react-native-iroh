import React from "react";
import { Text, View, StyleSheet } from "react-native";
import { Iroh } from "react-native-iroh";

function App(): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>nodeId</Text>
      <Text style={styles.text}>{Iroh.nodeId()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  label: {
    fontSize: 20,
    color: "gray",
  },
  text: {
    fontSize: 24,
    color: "green",
  },
});

export default App;
