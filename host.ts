import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";

import { hostContract } from "./lib/host-contract";
import { reportSources, UsageScanner } from "./lib/scan";

// bb runs this entry on every other machine. One scanner per worker keeps its
// parse caches warm between calls; their files live in this plugin's
// persistent data directory on that machine.
let scanner: UsageScanner | null = null;

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    scan(input, context) {
      scanner ??= new UsageScanner({ dataDir: context.experimental_paths.dataDir });
      // Cursor is account-wide and read by the server's machine.
      return scanner.readScan({ ...input, cursor: { enabled: false } });
    },
    detect({ claudeDirs }) {
      return reportSources({ claudeDirs, cursor: null });
    },
  },
  async dispose() {
    await scanner?.flush();
    scanner = null;
  },
});
