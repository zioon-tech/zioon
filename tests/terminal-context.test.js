import { describe, expect, it } from "vitest";
import {
  buildTerminalSessionsContextXml,
  selectTerminalContextSessions
} from "../extensions/dev.langchain-chat/terminal-context.js";

describe("terminal session context", () => {
  it("keeps an explicit active session first and caps the inventory", () => {
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      id: `session-${index}`,
      type: "local",
      cwd: `/workspace/${index}`,
      last_activity: 1000 + index,
      active: true
    }));

    const selected = selectTerminalContextSessions("session-2", sessions, { limit: 8 });

    expect(selected.activeSessionId).toBe("session-2");
    expect(selected.activeSessionInferred).toBe(false);
    expect(selected.sessions).toHaveLength(8);
    expect(selected.sessions[0].id).toBe("session-2");
    expect(selected.totalCount).toBe(30);
    expect(selected.omittedCount).toBe(22);
  });

  it("infers the most recently active session when selection state is missing", () => {
    const selected = selectTerminalContextSessions("", [
      { id: "old", cwd: "/old", active: true, last_activity: 10 },
      { id: "closed-new", cwd: "/closed", active: false, last_activity: 30 },
      { id: "recent", cwd: "/recent", active: true, last_activity: 20 }
    ]);

    expect(selected.activeSessionId).toBe("recent");
    expect(selected.activeSessionInferred).toBe(true);
    expect(selected.sessions[0].id).toBe("recent");
  });

  it("builds bounded XML with inventory metadata and escaped values", () => {
    const sessions = Array.from({ length: 25 }, (_, index) => ({
      id: `session-${index}`,
      type: index === 0 ? "ssh" : "local",
      cwd: index === 0 ? "/workspace/a&b" : `/workspace/${index}`,
      ssh_host: index === 0 ? "host<1>" : "",
      active: true,
      last_activity: 1000 - index
    }));

    const xml = buildTerminalSessionsContextXml("", sessions, { limit: 6 });

    expect(xml).toContain('<terminal_context total_count="25" included_count="6" omitted_count="19">');
    expect(xml).toContain('<active_session_id inferred="true">session-0</active_session_id>');
    expect(xml).toContain("/workspace/a&amp;b");
    expect(xml).toContain("host&lt;1&gt;");
    expect(xml.match(/<session /g)).toHaveLength(6);
    expect(xml).toContain("terminalManage");
    expect(xml.length).toBeLessThan(5000);
  });
});
