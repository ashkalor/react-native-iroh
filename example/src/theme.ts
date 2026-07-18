import { StyleSheet } from "react-native";

/** Shared section styling for the example screen. */
export const sectionStyles = StyleSheet.create({
  section: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d5d9e0",
  },
  heading: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1a1a2e",
    marginBottom: 10,
  },
  button: {
    backgroundColor: "#4636e3",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonLabel: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 14,
  },
  dimText: {
    fontSize: 12,
    color: "#5a5f6e",
  },
  errorText: {
    marginTop: 10,
    fontSize: 12,
    color: "#c0392b",
  },
  passText: {
    color: "#1e8449",
  },
  failText: {
    color: "#c0392b",
  },
  monoLine: {
    fontFamily: "monospace",
    fontSize: 12,
    marginBottom: 4,
  },
});
