import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import type { Transfer } from "react-native-iroh";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Live progress display for one download, isolated in a leaf component so
 * the ~30/s progress events re-render only this subtree, never the screen.
 *
 * The blob's total size is unknown at the API level (v0.1.0), so the bar is
 * an indeterminate sweep (Animated, native driver: no JS work per frame)
 * paired with a live cumulative byte counter; it snaps to a full bar once
 * the transfer settles.
 */
function ProgressBar({ transfer }: { transfer: Transfer }): React.JSX.Element {
  const [bytes, setBytes] = useState(0);
  const [settled, setSettled] = useState(false);
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let alive = true;
    const unsubscribe = transfer.onProgress((event) => {
      if (alive) {
        setBytes(event.bytesReceived);
      }
    });
    const markSettled = () => {
      if (alive) {
        setSettled(true);
      }
    };
    transfer.promise.then(markSettled, markSettled);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [transfer]);

  useEffect(() => {
    if (settled) {
      sweep.stopAnimation();
      return;
    }
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 1100,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [settled, sweep]);

  const translateX = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-90, 260],
  });

  return (
    <View style={styles.container}>
      <View style={styles.track}>
        {settled ? (
          <View style={styles.full} />
        ) : (
          <Animated.View style={[styles.sweep, { transform: [{ translateX }] }]} />
        )}
      </View>
      <Text style={styles.bytes} testID="progress-bytes">
        {settled ? `Done, ${formatBytes(bytes)} received` : `Receiving... ${formatBytes(bytes)}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 10,
    gap: 6,
  },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: "#e3e6ec",
    overflow: "hidden",
  },
  sweep: {
    width: 90,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#4636e3",
  },
  full: {
    flex: 1,
    backgroundColor: "#1e8449",
  },
  bytes: {
    fontSize: 12,
    color: "#5a5f6e",
    fontVariant: ["tabular-nums"],
  },
});

export default React.memo(ProgressBar);
