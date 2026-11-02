import { describe, expect, it } from "vitest";
import { WORKBENCH_NAVIGATION_FALLBACK_DENYLIST } from "../src/pwa-navigation";

function denied(pathname: string) {
  return WORKBENCH_NAVIGATION_FALLBACK_DENYLIST.some((pattern) => pattern.test(pathname));
}

describe("Workbench PWA navigation fallback", () => {
  it.each([
    "/v1/account/login",
    "/health",
    "/idp",
    "/idp/authorize",
    "/mobile/",
    "/observability/"
  ])("leaves server-owned route %s to the network", (pathname) => {
    expect(denied(pathname)).toBe(true);
  });

  it.each(["/", "/account", "/sessions/example"])(
    "keeps client route %s eligible for the Workbench fallback",
    (pathname) => {
      expect(denied(pathname)).toBe(false);
    }
  );
});
