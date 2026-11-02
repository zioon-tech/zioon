// @vitest-environment jsdom

import { matchRoutes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { terminalDetailPath, terminalRouteSessionId } from "../src/terminal-routing";

describe("Mobile terminal routing", () => {
  it("keeps global terminal reference components encoded after route matching", () => {
    const reference = "zterminal1:node%3Amac:instance%3Amac:workspace%2Fproject:session%2F1";
    const matches = matchRoutes(
      [{ path: "/terminal/:sessionId" }],
      terminalDetailPath(reference),
    );
    const routeParam = matches?.at(-1)?.params.sessionId || "";

    expect(routeParam).toBe(
      "zterminal1:node%3Amac:instance%3Amac:workspace/project:session/1",
    );
    expect(terminalRouteSessionId(routeParam)).toBe(reference);
  });

  it("does not rewrite native terminal IDs", () => {
    expect(terminalRouteSessionId("native/session")).toBe("native/session");
  });
});
