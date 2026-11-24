const COMMAND_ID = "identity.getSessionBiographyEvents";

/** An optional plugin may activate after the panel, or unload during a request. */
export function createContextBiographyCache({ getCommands, normalize, onChange }) {
  const entries = new Map();
  let commands = null;
  let available = false;
  let generation = 0;
  let disposed = false;

  function checkAvailability() {
    if (disposed) return false;
    const nextCommands = getCommands();
    let nextAvailable = false;
    try {
      nextAvailable = typeof nextCommands?.executeCommand === "function"
        && nextCommands.list?.().includes(COMMAND_ID) === true;
    } catch {}
    if (commands !== nextCommands || available !== nextAvailable) {
      commands = nextCommands;
      available = nextAvailable;
      generation += 1;
      entries.clear();
      onChange();
    }
    return available;
  }

  function get(sessionId) {
    const sid = String(sessionId || "").trim();
    if (!sid || !checkAvailability()) return [];
    let entry = entries.get(sid);
    if (!entry) {
      entry = { events: null, pending: null, version: 0 };
      entries.set(sid, entry);
    }
    if (entry.events === null && !entry.pending) refresh(sid, entry);
    return entry.events || [];
  }

  function refresh(sid, entry) {
    const epoch = generation;
    const version = entry.version;
    const isCurrent = () => !disposed && checkAvailability()
      && generation === epoch && entries.get(sid) === entry;
    // Start on a microtask so synchronous command results follow the same path.
    entry.pending = Promise.resolve().then(() => {
      if (!isCurrent()) return [];
      return commands.executeCommand(COMMAND_ID, { sessionId: sid });
    }).then(events => {
      if (!isCurrent() || entry.version !== version) return;
      entry.events = normalize(events);
      onChange();
    }).catch(() => {
      // Cache failure until invalidation; rendering must not cause a retry storm.
      if (isCurrent() && entry.version === version) entry.events = [];
    }).finally(() => {
      entry.pending = null;
      if (isCurrent() && entry.version !== version) refresh(sid, entry);
    });
  }

  return {
    get, checkAvailability,
    invalidate(sessionId) {
      const sid = String(sessionId || "").trim();
      if (!sid || disposed) return;
      const entry = entries.get(sid);
      if (entry) {
        entry.version += 1;
        entry.events = null;
      }
      get(sid);
    },
    dispose() {
      disposed = true;
      generation += 1;
      entries.clear();
    }
  };
}
