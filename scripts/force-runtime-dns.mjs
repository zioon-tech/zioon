import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

const HOST_OVERRIDES = new Map([
  ["47-101-150-8.nip.io", "47.101.150.8"]
]);

setGlobalDispatcher(new Agent({
  connect: {
    lookup(hostname, options, callback) {
      const address = HOST_OVERRIDES.get(String(hostname || "").toLowerCase());
      if (address) {
        if (options?.all) {
          callback(null, [{ address, family: 4 }]);
        } else {
          callback(null, address, 4);
        }
        return;
      }
      dns.lookup(hostname, options, callback);
    }
  }
}));
