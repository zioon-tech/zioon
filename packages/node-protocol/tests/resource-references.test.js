import { describe, expect, it } from "vitest";
import {
  terminalReference,
  parseTerminalReference,
  machineReference,
  parseMachineReference,
  isResourceReference
} from "../src/resource-references.mjs";

const target = {
  nodeId: "node:one",
  instanceId: "instance:one",
  resourceId: "workspace:one",
  sessionId: "terminal:/one%two"
};

describe("resource references", () => {
  it("round-trips reserved characters without collisions", () => {
    const id = terminalReference(target);
    expect(parseTerminalReference(id)).toEqual(target);
    expect(terminalReference({ ...target, nodeId: "node:two" })).not.toBe(id);
    expect(terminalReference({ ...target, instanceId: "instance:two" })).not.toBe(id);
    expect(isResourceReference(id)).toBe(true);
  });

  it("namespaces machines independently of terminal lifetimes", () => {
    const id = machineReference("node:one", "machine:local");
    expect(parseMachineReference(id)).toEqual({ nodeId: "node:one", machineId: "machine:local" });
    expect(machineReference("node:two", "machine:local")).not.toBe(id);
  });

  it("distinguishes native IDs from malformed global references", () => {
    expect(parseTerminalReference("native-id")).toBeNull();
    expect(parseMachineReference("machine:local")).toBeNull();
    expect(isResourceReference("zterminal2:future")).toBe(true);
    for (const id of ["zterminal1:a:b:c", "zterminal1:a:b:c:%XX", "zterminal1:a:b:c:%61"]) {
      expect(() => parseTerminalReference(id)).toThrow("Invalid terminal reference");
    }
  });

  it("rejects empty, control-character and oversized components", () => {
    for (const sessionId of ["", "a\nb", "x".repeat(1025)]) {
      expect(() => terminalReference({ ...target, sessionId })).toThrow();
    }
    expect(() => terminalReference({ ...target, sessionId: "/".repeat(1024), nodeId: "/".repeat(1024) })).toThrow("size limit");
  });
});
