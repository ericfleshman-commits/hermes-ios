import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  AppState,
  Image,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { loadDraft, saveDraft } from "../lib/drafts";
import { diagLog } from "../lib/diagLog";

export type PendingImage = {
  uri: string;
  base64: string;
  name: string;
};

export interface ComposerProps {
  sessionId?: string;
  onSend: (text: string, images: PendingImage[]) => void | boolean | Promise<void | boolean>;
  busy: boolean;
  connected?: boolean;
  allowQueue?: boolean;
  onImageError?: (err: string) => void;
}

// Image memory guard: cap a single photo's base64 (~8MB) and the total
// pending batch (~30MB) so large photo sends can't balloon memory.
const MAX_IMAGE_BASE64_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BASE64_BYTES = 30 * 1024 * 1024;

export const Composer = memo(function Composer({
  sessionId,
  onSend,
  busy,
  connected = true,
  allowQueue = false,
  onImageError,
}: ComposerProps) {
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const pendingImagesRef = useRef(pendingImages);
  const mounted = useRef(true);
  const inputRef = useRef(input);
  const queueingRef = useRef(false);
  inputRef.current = input;

  // Stash drafts per session so switching chats preserves unsent thoughts & photos
  const draftsRef = useRef<Map<string, { text: string; images: PendingImage[] }>>(new Map());
  const draftSessionRef = useRef<string | undefined>(sessionId);
  const editVersionRef = useRef(0);
  const draftLoadedRef = useRef(false);

  const persistText = useCallback((id: string, value: string) => {
    void saveDraft(id, value).catch(() => {
      onImageError?.("Couldn't save draft. Keep this chat open until saving works again.");
    });
  }, [onImageError]);
  const persistTextRef = useRef(persistText);
  persistTextRef.current = persistText;
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPersistRef = useRef<{ id: string; text: string } | null>(null);
  const flushPersist = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
    const pending = pendingPersistRef.current;
    pendingPersistRef.current = null;
    if (pending) persistTextRef.current(pending.id, pending.text);
  }, []);
  const schedulePersist = useCallback((id: string, text: string) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    pendingPersistRef.current = { id, text };
    // Keep the controlled input fast; one storage transaction per typing
    // burst instead of a serialized SecureStore read and write per key.
    persistTimerRef.current = setTimeout(flushPersist, 250);
  }, [flushPersist]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") flushPersist();
    });
    return () => sub.remove();
  }, [flushPersist]);

  useEffect(() => {
    let cancelled = false;
    const earlyText = !draftSessionRef.current && sessionId ? inputRef.current : "";
    draftSessionRef.current = sessionId;
    draftLoadedRef.current = false;
    const version = ++editVersionRef.current;
    const cached = earlyText ? { text: earlyText, images: pendingImagesRef.current } :
      sessionId ? draftsRef.current.get(sessionId) : undefined;
    if (earlyText && sessionId) persistTextRef.current(sessionId, earlyText);
    inputRef.current = cached?.text || "";
    pendingImagesRef.current = cached?.images || [];
    setInput(inputRef.current);
    setPendingImages(pendingImagesRef.current);
    if (cached) {
      draftLoadedRef.current = true;
    } else if (sessionId) {
      void loadDraft(sessionId).then((saved) => {
        // A late read must not overwrite another chat or fresh typing.
        if (cancelled || editVersionRef.current !== version) return;
        draftLoadedRef.current = true;
        inputRef.current = saved;
        setInput(saved);
      }).catch(() => {
        if (!cancelled) onImageError?.("Couldn't restore this draft. Try reopening the chat.");
      });
    }
    return () => {
      cancelled = true;
      if (sessionId && draftLoadedRef.current) {
        const text = inputRef.current;
        draftsRef.current.set(sessionId, { text, images: pendingImagesRef.current });
        if (pendingPersistRef.current?.id === sessionId) flushPersist();
        else persistTextRef.current(sessionId, text);
      }
    };
  }, [sessionId]);

  const changeInput = useCallback((value: string) => {
    editVersionRef.current++;
    draftLoadedRef.current = true;
    inputRef.current = value;
    setInput(value);
    const id = draftSessionRef.current;
    if (id) schedulePersist(id, value);
  }, [schedulePersist]);

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const handleImageAssets = useCallback(
    (assets: ImagePicker.ImagePickerAsset[]) => {
      if (!mounted.current || !assets?.length) return;
      let currentTotal = pendingImagesRef.current.reduce(
        (acc, p) => acc + (p.base64 ? p.base64.length : 0),
        0,
      );
      const accepted: PendingImage[] = [];
      const errs: string[] = [];

      for (let i = 0; i < assets.length; i++) {
        const a = assets[i];
        const base64 = a.base64 ?? "";
        const name = a.fileName ?? `photo-${Date.now()}-${i}.jpg`;
        const size = base64.length;

        if (size > MAX_IMAGE_BASE64_BYTES) {
          errs.push(`Photo "${name}" exceeds 8MB limit and was dropped.`);
          continue;
        }
        if (currentTotal + size > MAX_TOTAL_BASE64_BYTES) {
          errs.push(`Photo "${name}" dropped: total pending images exceeds 30MB limit.`);
          continue;
        }

        currentTotal += size;
        accepted.push({
          uri: a.uri,
          base64,
          name,
        });
      }

      if (accepted.length > 0) {
        setPendingImages((prev) => [...prev, ...accepted].slice(0, 20));
      }

      if (errs.length > 0) {
        errs.forEach((err) => onImageError?.(err));
      }
    },
    [onImageError],
  );

  const takeCameraPhoto = useCallback(async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.65,
      base64: true,
    });
    if (res.canceled || !res.assets) return;
    handleImageAssets(res.assets);
  }, [handleImageAssets]);

  const pickLibraryPhotos = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: 20,
      quality: 0.65,
      base64: true,
    });
    if (res.canceled || !res.assets) return;
    handleImageAssets(res.assets);
  }, [handleImageAssets]);

  const pickPhotos = useCallback(() => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Cancel", "📷 Take Photo", "🖼 Choose from Photos"],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) void takeCameraPhoto();
          else if (buttonIndex === 2) void pickLibraryPhotos();
        },
      );
    } else {
      void pickLibraryPhotos();
    }
  }, [takeCameraPhoto, pickLibraryPhotos]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const imgs = pendingImages;
    if (busy && (text || imgs.length > 0)) {
      // The tap is about to be swallowed by the busy pill. Metadata only:
      // never log the text or image contents.
      diagLog("send_blocked", { guard: "composer_busy" });
    }
    if ((!text && imgs.length === 0) || busy || queueingRef.current ||
        (!connected && (!allowQueue || imgs.length > 0))) return;
    const draftId = draftSessionRef.current;
    const version = editVersionRef.current;
    queueingRef.current = true;
    try {
      const accepted = await onSend(text, imgs);
      if (accepted === false || !mounted.current) return;
    } catch (e) {
      onImageError?.((e as Error).message || "Couldn't accept message");
      return;
    } finally { queueingRef.current = false; }
    // An acceptance for an older draft must not clear new typing or another chat.
    if (draftSessionRef.current !== draftId || editVersionRef.current !== version) return;
    changeInput("");
    flushPersist();
    pendingImagesRef.current = [];
    setPendingImages([]);
    Keyboard.dismiss();
  }, [input, pendingImages, busy, connected, allowQueue, onSend, onImageError, changeInput, flushPersist]);

  const canSend = (input.trim().length > 0 || pendingImages.length > 0) && !busy &&
    (connected || (allowQueue && pendingImages.length === 0 && !!sessionId));

  return (
    <View style={styles.container}>
      {pendingImages.length > 0 && (
        <View style={styles.thumbRow}>
          {pendingImages.map((p, i) => (
            <TouchableOpacity
              key={p.uri || `img-${i}`}
              onPress={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
            >
              <Image source={{ uri: p.uri }} style={styles.thumb} />
              <Text style={styles.thumbX}>✕</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.composer}>
        <TouchableOpacity style={styles.cameraBtn} onPress={() => void pickPhotos()}>
          <Text style={styles.cameraText}>📷</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={changeInput}
          placeholder="Message Hermes..."
          placeholderTextColor="#6b6f7c"
          multiline
          // Set explicitly: Fabric only applies these traits when the prop
          // CHANGES, so leaving them unset on mount means nil == nil and the
          // native default sticks (autocorrect off).
          autoCorrect
          spellCheck
          autoCapitalize="sentences"
        />
        <TouchableOpacity
          style={[
            styles.sendBtn,
            !canSend && styles.sendDisabled,
            busy && styles.sendBusy,
          ]}
          disabled={!canSend}
          activeOpacity={0.6}
          onPress={handleSend}
        >
          <Text style={styles.sendText}>↑</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

export default Composer;

const styles = StyleSheet.create({
  container: {
    backgroundColor: "transparent",
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4,
    marginHorizontal: 14,
    marginTop: 10,
    paddingHorizontal: 5,
    paddingVertical: 4,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "#514075",
    backgroundColor: "#191522",
    shadowColor: "#8b68da",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 3,
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 140,
    backgroundColor: "transparent",
    color: "#f2f3f7",
    paddingHorizontal: 8,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15.5,
    lineHeight: 21,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#7c66dc",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#7c66dc",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  sendDisabled: { opacity: 0.25, backgroundColor: "#2d2847", shadowOpacity: 0 },
  sendBusy: { opacity: 0.45 },
  sendText: { color: "#ffffff", fontSize: 20, fontWeight: "700" },
  cameraBtn: {
    width: 40,
    height: 42,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  cameraText: { fontSize: 19 },
  thumbRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 8,
    backgroundColor: "transparent",
  },
  thumb: { width: 56, height: 56, borderRadius: 10, borderWidth: 1, borderColor: "#332a56" },
  thumbX: {
    position: "absolute",
    top: -4,
    right: -4,
    color: "#fff",
    backgroundColor: "#f85149",
    borderRadius: 9,
    fontSize: 10,
    paddingHorizontal: 4,
    overflow: "hidden",
  },
});
