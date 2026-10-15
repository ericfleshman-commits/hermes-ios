import React, { useEffect, useState } from "react";
import { Keyboard, Platform, View, useWindowDimensions, type KeyboardEvent, type ViewProps } from "react-native";

// This full-height chat ends at the window bottom. Apply keyboard overlap in
// one layout commit: KeyboardAvoidingView starts another timed layout animation
// after receiving the event, which can leave the composer chasing the keyboard.
// Keep the decorative backdrop outside this view and keyboard state below App.
export function KeyboardChatLayout({ style, children, ...props }: ViewProps) {
  const { height } = useWindowDimensions();
  const [frame, setFrame] = useState<{ screenY: number; height: number } | null>(null);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const update = (event: KeyboardEvent) => {
      const { screenY, height: keyboardHeight } = event.endCoordinates;
      setFrame(keyboardHeight > 0 && Number.isFinite(keyboardHeight) && Number.isFinite(screenY)
        ? { screenY, height: keyboardHeight } : null);
    };
    const subscriptions = [
      Keyboard.addListener("keyboardWillShow", update),
      Keyboard.addListener("keyboardWillChangeFrame", update),
      Keyboard.addListener("keyboardWillHide", () => setFrame(null)),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, []);
  // iOS can report a zero origin with accessibility transition settings.
  // Never reserve more than the keyboard's own height.
  const overlap = frame === null ? 0 : Math.min(frame.height, height, Math.max(0, height - frame.screenY));
  return (
    <View {...props} testID="keyboard-chat-layout" style={[style, { paddingBottom: overlap }]}>
      {children}
    </View>
  );
}
