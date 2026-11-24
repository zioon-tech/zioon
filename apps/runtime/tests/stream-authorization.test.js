import { afterEach, expect, it, vi } from "vitest";
import { CancellationController } from "../../../packages/runtime/dist/index.js";
import { createStreamAuthorization } from "../src/sharing/stream-authorization.mjs";
afterEach(() => vi.useRealTimers());
it("coalesces concurrent boundaries and never blocks tokens on database validation", async () => {
  let finish;
  const validate = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const guard = createStreamAuthorization(validate, new CancellationController().signal);
  const first = guard.check(true);
  expect(guard.check(true)).toBe(first); expect(guard.check()).toBe(first);
  await Promise.resolve(); finish(); await first;
  for (let i = 0; i < 1000; i++) guard.assert();
  expect(validate).toHaveBeenCalledOnce();
  await guard.close();
});
it("cancels a silent upstream when periodic authority fails", async () => {
  vi.useFakeTimers();
  const denied = Object.assign(new Error("revoked"), { code: "share_access_revoked" });
  const validate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(denied);
  const guard = createStreamAuthorization(validate, new CancellationController().signal);
  await guard.check(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(guard.signal.cancelled).toBe(true);
  expect(() => guard.assert()).toThrow(denied);
  await guard.close(); const calls = validate.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(validate.mock.calls.length).toBe(calls);
});
