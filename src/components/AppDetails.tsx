import React, { useEffect, useRef, useState } from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { GatewayClient, ConnState } from "../lib/gateway";
import { usageLines, diagnosticReport } from "../lib/appStatus";
import { getOtaStatus } from "../lib/otaUpdates";

function otaLine(): string {
  const s = getOtaStatus();
  if (!s.isEnabled) return "OTA: disabled in this build";
  if (s.lastCheckedAt === null) return "OTA: not yet checked";
  const shortId = s.updateId ? s.updateId.slice(0, 8) : "embedded";
  const checked = new Date(s.lastCheckedAt).toLocaleTimeString();
  return `OTA: ${shortId} · ${s.channel ?? "no-channel"} · ${s.lastResult} · checked ${checked}`;
}

export function AppDetails({ visible, onClose, gateway, sessionId, provider, build, connection, delivery }: {
  visible: boolean; onClose: () => void; gateway: GatewayClient | null; sessionId: string;
  provider: string; build: string; connection: ConnState; delivery: string;
}) {
  const [snapshot, setSnapshot] = useState<{ usage: any; billing: any; time: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const refresh = async () => {
    const gen = ++generation.current;
    setSnapshot(null); setError(""); setCopied(false);
    if (!gateway || connection !== "open" || !sessionId) {
      setError("Reconnect to load current usage."); setLoading(false); return;
    }
    setLoading(true);
    const [usage, billing] = await Promise.allSettled([
      gateway.request("session.usage", { session_id: sessionId }, 12000),
      provider === "nous" ? gateway.request("billing.state", {}, 12000) : Promise.resolve(null),
    ]);
    if (gen !== generation.current) return;
    setSnapshot({ usage: usage.status === "fulfilled" ? usage.value : null,
      billing: billing.status === "fulfilled" ? billing.value : null, time: new Date().toLocaleTimeString() });
    if (usage.status === "rejected" || billing.status === "rejected") setError("Some usage data is unavailable. Try refreshing.");
    setLoading(false);
  };
  useEffect(() => {
    if (visible) void refresh();
    return () => { generation.current++; };
  }, [visible, gateway, sessionId, provider, connection]);
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.title}>App status & usage</Text>
      <Text style={styles.text}>{build}</Text>
      <Text style={styles.text}>Connection: {connection}</Text>
      <Text style={styles.text}>Last send: {delivery || "None in this chat"}</Text>
      <Text style={styles.text}>{otaLine()}</Text>
      <Text style={styles.text}>Provider: {provider || "Not selected"}</Text>
      {usageLines(snapshot?.usage, snapshot?.billing, provider).map(line => <Text key={line} style={styles.text}>{line}</Text>)}
      <Text style={styles.text}>{loading ? "Loading usage..." : snapshot ? `Fetched at ${snapshot.time}. Provider totals may lag.` : "No current usage snapshot."}</Text>
      {!!error && <Text style={styles.text}>{error}</Text>}
      <TouchableOpacity disabled={loading} onPress={() => void refresh()} style={styles.button}><Text style={styles.text}>Refresh usage</Text></TouchableOpacity>
      <TouchableOpacity style={styles.button} onPress={() => {
        void Clipboard.setStringAsync(diagnosticReport({ build, connection, provider, delivery }))
          .then(() => setCopied(true)).catch(() => setError("Couldn't copy diagnostics."));
      }}><Text style={styles.text}>{copied ? "Copied" : "Copy safe diagnostics"}</Text></TouchableOpacity>
      <Text style={styles.text}>Diagnostics exclude chat text, account credentials, connection URLs, and raw errors.</Text>
      <TouchableOpacity style={styles.button} onPress={onClose}><Text style={styles.text}>Close</Text></TouchableOpacity>
    </ScrollView>
  </Modal>;
}
const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: 24, paddingTop: 70, backgroundColor: "#09090d", gap: 14 },
  title: { fontSize: 22, fontWeight: "700", color: "#f2f3f7" },
  text: { fontSize: 15, color: "#e6e6ee" },
  button: { backgroundColor: "#332a56", padding: 14, borderRadius: 12 },
});
