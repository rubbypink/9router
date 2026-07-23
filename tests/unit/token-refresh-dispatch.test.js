// Guards the refactored REFRESH_HANDLERS dispatch: null-guards + the two different defaults.
import { afterEach, describe, it, expect, vi } from "vitest";

const load = () => import("../../open-sse/services/tokenRefresh.js");

afterEach(() => vi.useRealTimers());

describe("tokenRefresh dispatch", () => {
  it("getAccessToken returns null for missing/invalid refreshToken", async () => {
    const mod = await load();
    expect(await mod.getAccessToken("claude", {}, null)).toBeNull();
    expect(await mod.getAccessToken("claude", { refreshToken: 123 }, null)).toBeNull();
  });

  it("getAccessToken default: unsupported provider → null", async () => {
    const mod = await load();
    expect(await mod.getAccessToken("totally-unknown", { refreshToken: "x" }, null)).toBeNull();
  });

  it("refreshTokenByProvider returns null without refreshToken", async () => {
    const mod = await load();
    expect(await mod.refreshTokenByProvider("claude", {}, null)).toBeNull();
  });

  it("caps refresh attempts at two", async () => {
    vi.useFakeTimers();
    const mod = await load();
    const refresh = vi.fn(async () => { throw new Error("refresh failed"); });
    const result = mod.refreshWithRetry(refresh, 5);

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBeNull();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
