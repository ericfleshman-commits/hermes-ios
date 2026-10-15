import React, { useEffect, useState } from "react";
import { Keyboard, Platform, View, type ViewProps } from "react-native";
import { composerDockBottomPadding, keyboardEvents } from "../lib/layout";

// Keep keyboard-only state below MainChat. Updating the home-indicator padding
// must not rebuild the transcript, drawer, and picker while iOS moves the keyboard.
export function ComposerDock({ bottomInset, style, children, ...props }: ViewProps & { bottomInset: number }) {
  const [keyboardUp, setKeyboardUp] = useState(false);
  useEffect(() => {
    const events = keyboardEvents(Platform.OS);
    const show = Keyboard.addListener(events.show, () => setKeyboardUp(true));
    const hide = Keyboard.addListener(events.hide, () => setKeyboardUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return (
    <View {...props} style={[style, { paddingBottom: composerDockBottomPadding(bottomInset, keyboardUp) }]}>
      {children}
    </View>
  );
}
