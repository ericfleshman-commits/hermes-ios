// Adds the gateway host to app.json's config at build, OTA, and dev-server time.
// Set HERMES_GATEWAY_HOST, or copy gateway.example.json to gateway.local.json
// (gitignored). Missing config fails the build instead of shipping an app with
// no server to talk to.
const fs = require("fs");
const path = require("path");

function readLocalHost() {
  try {
    const file = path.join(__dirname, "gateway.local.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).gatewayHost;
  } catch {
    return undefined;
  }
}

module.exports = ({ config }) => {
  const gatewayHost = process.env.HERMES_GATEWAY_HOST || readLocalHost();
  if (!gatewayHost) {
    throw new Error(
      "No gateway host. Set HERMES_GATEWAY_HOST or create gateway.local.json " +
        'from gateway.example.json ({"gatewayHost": "your-host:9220"}).'
    );
  }
  return { ...config, extra: { ...config.extra, gatewayHost } };
};
