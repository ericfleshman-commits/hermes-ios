import React, { memo, useRef } from "react";
import { shouldSuppressCopy } from "../lib/copyGuard";
import {
  ActivityIndicator,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";
import type { Msg } from "../hooks/useChatStore";

export interface MessageRowProps {
  item: Msg;
  isCopied: boolean;
  onCopy: (msg: Msg) => void;
  onRetry?: (msg: Msg) => void;
  onLinkPress?: (url: string) => boolean;
  onLongPressAction?: (msg: Msg) => void;
}

function areMessagePropsEqual(prev: MessageRowProps, next: MessageRowProps): boolean {
  if (prev.isCopied !== next.isCopied) return false;
  if (prev.onRetry !== next.onRetry) return false;
  if (prev.onCopy !== next.onCopy) return false;
  if (prev.onLinkPress !== next.onLinkPress) return false;
  if (prev.onLongPressAction !== next.onLongPressAction) return false;

  const m1 = prev.item;
  const m2 = next.item;

  if (m1 === m2) return true;
  if (m1.id !== m2.id) return false;
  if (m1.role !== m2.role) return false;
  if (m1.text !== m2.text) return false;
  if (m1.streaming !== m2.streaming) return false;
  if (m1.thinking !== m2.thinking) return false;
  if (m1.sendFailed !== m2.sendFailed) return false;
  if (m1.sendError !== m2.sendError) return false;
  if (m1.sending !== m2.sending) return false;

  const t1 = m1.tools;
  const t2 = m2.tools;
  if (t1 !== t2) {
    if (!t1 || !t2) return false;
    if (t1.length !== t2.length) return false;
    for (let i = 0; i < t1.length; i++) {
      if (t1[i] !== t2[i]) return false;
    }
  }

  const i1 = m1.images;
  const i2 = m2.images;
  if (i1 !== i2) {
    if (!i1 || !i2) return false;
    if (i1.length !== i2.length) return false;
    for (let i = 0; i < i1.length; i++) {
      if (i1[i] !== i2[i]) return false;
    }
  }

  return true;
}

export const MessageRow = memo(function MessageRow({
  item,
  isCopied,
  onCopy,
  onRetry,
  onLinkPress,
  onLongPressAction,
}: MessageRowProps) {
  // A link tap inside the bubble also fires the bubble's onPress. Stamp the
  // link press so the copy below can tell the two apart.
  const lastLinkAt = useRef(0);
  const handleLinkPress = onLinkPress
    ? (url: string) => {
        lastLinkAt.current = Date.now();
        return onLinkPress(url);
      }
    : undefined;
  if (
    item.role === "assistant" &&
    !item.text &&
    !item.thinking &&
    (!item.tools || item.tools.length === 0) &&
    !item.streaming
  ) {
    return null;
  }

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onLongPress={() => (onLongPressAction ? onLongPressAction(item) : void onCopy(item))}
      delayLongPress={250}
      onPress={
        item.role === "error" && item.text?.includes("retry")
          ? () => void onRetry?.(item)
          : item.sendFailed
            ? () => void onRetry?.(item)
            : item.role === "assistant" && !item.streaming
              ? () => {
                  if (shouldSuppressCopy(lastLinkAt.current)) return;
                  void onCopy(item);
                }
              : undefined
      }
      style={[
        s.bubble,
        item.role === "user" ? s.user : item.role === "error" ? s.err : s.assistant,
        item.sendFailed && s.sendFailedBubble,
      ]}
    >
      {item.role === "assistant" && item.tools && item.tools.length > 0 && (
        <View style={s.toolRow}>
          {item.tools.map((t, idx) => (
            <View key={idx} style={s.toolBadge}>
              <Text style={s.toolText}>⚙ {t}</Text>
            </View>
          ))}
        </View>
      )}
      {!!item.thinking && (
        <Text style={s.thinking} numberOfLines={2}>
          💭 {item.thinking.trim().split("\n")[0]}
        </Text>
      )}
      {item.images && item.images.length > 0 && (
        <View style={s.bubbleImgRow}>
          {item.images.map((uri: string, i: number) => (
            <Image key={i} source={{ uri }} style={s.bubbleImg} />
          ))}
        </View>
      )}
      {item.role === "assistant" ? (
        item.streaming ? (
          // Stream raw text until complete — re-parsing Markdown on
          // every delta is O(n²) and causes flicker/jank mid-stream.
          <Text style={s.assistantText}>{item.text || "…"}</Text>
        ) : (
          <Markdown style={mdStyles as any} onLinkPress={handleLinkPress}>
            {item.text || ""}
          </Markdown>
        )
      ) : (
        <Text style={item.role === "error" ? s.errText : s.userText}>
          {item.text || (item.streaming ? "…" : "")}
        </Text>
      )}
      {/* Failed sends stay on their own message: the text is kept and a tap
          retries the exact turn. Never a separate error row, never dropped. */}
      {item.sendFailed && (
        <Text style={s.sendFailedText}>
          ⚠ Not sent — tap to retry{item.sendError ? `: ${item.sendError}` : ""}
        </Text>
      )}
      {/* While the submit is in flight the bubble carries an inline sending
          state: a spinner plus text (never color alone), with an
          accessibility label for screen readers. */}
      {!!item.sending && !item.sendFailed && (
        <View
          style={s.sendingRow}
          accessibilityRole="text"
          accessibilityLabel="Sending"
        >
          <ActivityIndicator size="small" color="#8e86aa" />
          <Text style={s.sendingText}>Sending…</Text>
        </View>
      )}
      {isCopied && <Text style={s.copied}>Copied ✓</Text>}
    </TouchableOpacity>
  );
}, areMessagePropsEqual);

export default MessageRow;

const s = StyleSheet.create({
  bubble: {
    maxWidth: "84%",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
  },
  user: {
    alignSelf: "flex-end",
    backgroundColor: "#634bc4",
    borderColor: "#7c66dc",
    borderBottomRightRadius: 4,
    shadowColor: "#634bc4",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  assistant: {
    alignSelf: "flex-start",
    backgroundColor: "#161224",
    borderColor: "#292144",
    borderBottomLeftRadius: 4,
  },
  err: {
    alignSelf: "flex-start",
    backgroundColor: "#200e17",
    borderColor: "#4d1a29",
    borderBottomLeftRadius: 4,
  },
  sendFailedBubble: {
    borderColor: "#8a2b3a",
    borderWidth: 1,
  },
  userText: { color: "#ffffff", fontSize: 15.5, lineHeight: 22 },
  assistantText: { color: "#edeef5", fontSize: 15.5, lineHeight: 22 },
  errText: { color: "#f85149", fontSize: 14, lineHeight: 20 },
  sendFailedText: { color: "#ff9b9b", fontSize: 12.5, fontWeight: "600", marginTop: 6 },
  sendingRow: { flexDirection: "row", alignItems: "center", marginTop: 6, gap: 6 },
  sendingText: { color: "#8e86aa", fontSize: 12.5, fontWeight: "500" },
  toolRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  toolBadge: {
    backgroundColor: "#1e1838",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3b2e6b",
  },
  toolText: { color: "#c4b5fd", fontSize: 11.5, fontWeight: "600", letterSpacing: 0.2 },
  thinking: {
    color: "#8e86aa",
    fontSize: 12,
    lineHeight: 17,
    fontStyle: "italic",
    marginBottom: 8,
    borderLeftWidth: 2,
    borderLeftColor: "#4f3e82",
    paddingLeft: 8,
  },
  bubbleImgRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  bubbleImg: { width: 140, height: 140, borderRadius: 12, borderWidth: 1, borderColor: "#332a56" },
  copied: { color: "#3ddc84", fontSize: 11, fontWeight: "600", marginTop: 4 },
});

const mdStyles = {
  body: { color: "#e6e6ee", fontSize: 15, lineHeight: 21 },
  paragraph: { marginTop: 0, marginBottom: 8, lineHeight: 21 },
  strong: { color: "#f2f3f7", fontWeight: "700", lineHeight: 21 },
  em: { fontStyle: "italic", color: "#e6e6ee", lineHeight: 21 },
  heading1: { color: "#f2f3f7", fontSize: 18, lineHeight: 24, fontWeight: "700", marginTop: 8, marginBottom: 4 },
  heading2: { color: "#f2f3f7", fontSize: 16, lineHeight: 22, fontWeight: "700", marginTop: 8, marginBottom: 4 },
  heading3: { color: "#f2f3f7", fontSize: 15, lineHeight: 21, fontWeight: "700", marginTop: 6, marginBottom: 2 },
  code_inline: {
    backgroundColor: "#1c1d26",
    color: "#c4b5fd",
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 13,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 5,
  },
  fence: {
    backgroundColor: "#161227",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#4a3d80",
    padding: 12,
    marginVertical: 8,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 12.5,
    lineHeight: 18,
    color: "#c4b5fd",
  },
  fence_container: {
    backgroundColor: "#161227",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#4a3d80",
  },
  link: {
    color: "#a78bfa",
    textDecorationLine: "underline",
    // A URL has no spaces. Let its nested native Text node shrink and use
    // iOS's standard URL-aware line breaks instead of spilling past a bubble.
    flexShrink: 1,
    flexWrap: "wrap",
    lineBreakStrategyIOS: "standard",
    textBreakStrategy: "highQuality",
  },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { flexDirection: "row", alignItems: "flex-start" },
  bullet_list_icon: { color: "#a78bfa", marginRight: 8, marginTop: 2 },
  ordered_list_icon: { color: "#a78bfa", marginRight: 8, marginTop: 2 },
  bullet_list_content: { flex: 1, flexShrink: 1 },
  ordered_list_content: { flex: 1, flexShrink: 1 },
  blockquote: { backgroundColor: "#1d1540", borderLeftColor: "#a78bfa", borderLeftWidth: 3, paddingHorizontal: 10, paddingVertical: 4, marginVertical: 4 },
  hr: { backgroundColor: "#332a56" },
};
