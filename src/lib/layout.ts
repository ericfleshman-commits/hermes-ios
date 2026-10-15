// Layout maths that has to agree with the device, kept out of the component so
// it can be tested without a renderer.
//
// iOS gives a 34pt bottom safe-area inset on every phone with a home indicator.
// Those devices all run an aspect ratio above 2:1 (iPhone X and later), while
// SE-class phones sit below it and need no inset at all. Deriving it this way
// avoids pulling in react-native-safe-area-context, a native module.
export function bottomInsetFor(platform: string, width: number, height: number): number {
  if (platform !== "ios") return 0;
  if (!(width > 0) || !(height > 0)) return 0;
  return height / width >= 2 ? 34 : 0;
}

export function composerDockBottomPadding(bottomInset: number, keyboardUp: boolean): number {
  return keyboardUp ? 6 : Math.max(8, bottomInset);
}

// iOS fires the "will" pair before the keyboard animates; Android only has the
// "did" pair. Using the wrong pair leaves stale state and hides the status row.
export type KeyboardEventName =
  | "keyboardWillShow"
  | "keyboardWillHide"
  | "keyboardDidShow"
  | "keyboardDidHide";

export function keyboardEvents(platform: string): { show: KeyboardEventName; hide: KeyboardEventName } {
  return platform === "ios"
    ? { show: "keyboardWillShow", hide: "keyboardWillHide" }
    : { show: "keyboardDidShow", hide: "keyboardDidHide" };
}
