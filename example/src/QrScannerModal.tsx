import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  type CameraDevice,
} from "react-native-vision-camera";
import {
  useBarcodeScannerOutput,
  type Barcode,
  type TargetBarcodeFormat,
} from "react-native-vision-camera-barcode-scanner";
import { sectionStyles } from "./theme";

/**
 * Hoisted because {@link useBarcodeScannerOutput} memoises on this array by
 * reference: a fresh literal every render would tear down and rebuild the
 * native scanner output on each commit.
 */
const QR_ONLY: TargetBarcodeFormat[] = ["qr-code"];

/** Either a camera we can stream, or the reason we cannot. */
type Viewfinder = { ready: true; device: CameraDevice } | { ready: false; reason: string };

function viewfinder(
  hasPermission: boolean,
  canRequestPermission: boolean,
  device: CameraDevice | undefined,
): Viewfinder {
  if (!hasPermission) {
    return {
      ready: false,
      reason: canRequestPermission
        ? "Waiting for camera permission..."
        : "Camera permission denied. Grant it in Settings, or paste the code instead.",
    };
  }
  if (device === undefined) {
    return { ready: false, reason: "No camera on this device. Paste the code instead." };
  }
  return { ready: true, device };
}

interface QrScannerModalProps {
  /** Shown under the viewfinder, so the same scanner can explain either flow. */
  prompt: string;
  onScanned: (value: string) => void;
  onCancel: () => void;
}

/**
 * Full-screen QR reader that resolves to the decoded text exactly once.
 *
 * Mount it only while scanning: the barcode output and the camera session are
 * native resources created on mount, and there is no reason to hold a camera
 * open behind a closed sheet. Callers therefore render it conditionally rather
 * than passing a `visible` flag.
 *
 * Both of this app's pairing flows (a blob ticket, a gossip endpoint id) hand
 * over one opaque string, so neither is interpreted here. The value passes
 * through verbatim and is validated by whoever asked for it.
 */
function QrScannerModal({ prompt, onScanned, onCancel }: QrScannerModalProps): React.JSX.Element {
  const { hasPermission, requestPermission, canRequestPermission } = useCameraPermission();
  const device = useCameraDevice("back");
  const [scanError, setScanError] = useState<string | null>(null);

  // MLKit re-reports the same code on every frame it stays in view. Latching on
  // the first hit keeps the caller's handler idempotent and stops the modal
  // resolving twice if a second code drifts into frame.
  const delivered = useRef(false);

  useEffect(() => {
    if (!hasPermission && canRequestPermission) {
      void requestPermission();
    }
  }, [hasPermission, canRequestPermission, requestPermission]);

  const onBarcodeScanned = useCallback(
    (barcodes: Barcode[]) => {
      if (delivered.current) {
        return;
      }
      const value = barcodes.find(
        (barcode) => barcode.rawValue !== undefined && barcode.rawValue.length > 0,
      )?.rawValue;
      if (value === undefined) {
        return;
      }
      delivered.current = true;
      onScanned(value);
    },
    [onScanned],
  );

  const onError = useCallback((error: Error) => {
    setScanError(error.message);
  }, []);

  const output = useBarcodeScannerOutput({
    barcodeFormats: QR_ONLY,
    onBarcodeScanned,
    onError,
  });

  // `useCamera` keeps `outputs` in an effect dependency, so a fresh array
  // literal per render would reconfigure the session on every commit.
  const outputs = useMemo(() => [output], [output]);

  const state = viewfinder(hasPermission, canRequestPermission, device);

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <View style={styles.container}>
        {state.ready ? (
          <Camera
            style={styles.camera}
            device={state.device}
            isActive
            outputs={outputs}
            onError={onError}
          />
        ) : (
          <View style={[styles.camera, styles.unavailable]}>
            <Text style={styles.unavailableText} testID="qr-scanner-unavailable">
              {state.reason}
            </Text>
          </View>
        )}

        <View style={styles.footer}>
          <Text style={styles.prompt}>{prompt}</Text>
          {scanError !== null ? (
            <Text style={styles.scanError} testID="qr-scanner-error">
              {scanError}
            </Text>
          ) : null}
          <TouchableOpacity
            testID="qr-scanner-cancel"
            accessibilityRole="button"
            style={sectionStyles.button}
            onPress={onCancel}
          >
            <Text style={sectionStyles.buttonLabel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  camera: {
    flex: 1,
  },
  unavailable: {
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  unavailableText: {
    color: "#ffffff",
    fontSize: 14,
    textAlign: "center",
  },
  footer: {
    padding: 16,
    gap: 10,
    backgroundColor: "#101018",
  },
  prompt: {
    color: "#e6e8ef",
    fontSize: 13,
    textAlign: "center",
  },
  scanError: {
    color: "#ff8a7a",
    fontSize: 12,
    textAlign: "center",
  },
});

export default React.memo(QrScannerModal);
