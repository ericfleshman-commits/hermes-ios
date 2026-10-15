
import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";

type Props = { children: React.ReactNode };
type State = {
  error: Error | null;
  count: number;
  maxReloads: number;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, count: 0, maxReloads: 3 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Log for remote diagnosis — console.warn keeps it in Metro logs.
    console.warn("APP CRASH BOUNDED:", error?.message, info?.componentStack?.slice(0, 500));
  }

  private reset = () => {
    const nextCount = this.state.count + 1;
    if (nextCount >= this.state.maxReloads) {
      // Repeated crash from the same data — don't loop forever. Point at a restart.
      return;
    }
    this.setState({ error: null, count: nextCount });
  };

  render() {
    if (this.state.error) {
      const exhausted = this.state.count >= this.state.maxReloads;
      return (
        <View style={styles.center}>
          <Text style={styles.title}>Something broke</Text>
          <Text style={styles.msg}>{String(this.state.error?.message || "Unknown error").slice(0, 300)}</Text>
          {exhausted ? (
            <Text style={styles.guide}>The same error keeps coming back. Close and reopen the app to reset.</Text>
          ) : (
            <TouchableOpacity style={styles.btn} onPress={this.reset}>
              <Text style={styles.btnText}>Try again</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: "#0a0a0d", alignItems: "center", justifyContent: "center", padding: 24 },
  title: { color: "#a78bfa", fontSize: 18, fontWeight: "700", marginBottom: 8 },
  msg: { color: "#9a9fad", fontSize: 13, textAlign: "center", marginBottom: 20 },
  btn: { backgroundColor: "#a78bfa", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  btnText: { color: "#0a0a0d", fontWeight: "700", fontSize: 15 },
  guide: { color: "#9a9fad", fontSize: 13, textAlign: "center", marginTop: 4 },
});
