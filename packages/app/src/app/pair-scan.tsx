import { Redirect } from "expo-router";

// COMPAT(retiredPairingRoute): added in v155, retain until saved pairing routes are unsupported.
export default function RetiredPairingRoute() {
  return <Redirect href="/settings/connections" />;
}
