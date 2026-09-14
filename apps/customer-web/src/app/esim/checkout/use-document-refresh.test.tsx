import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDocumentRefresh } from "./use-document-refresh";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("continues refreshing after a connection failure and stops on unmount", async () => {
  vi.useFakeTimers();
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const error = vi.fn();
  const view = renderHook(() => useDocumentRefresh(true, refresh, error));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(error).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("invalidates an in-flight read when uploads begin", async () => {
  vi.useFakeTimers();
  let isCurrent = () => false;
  let finish!: () => void;
  const refresh = vi.fn((active: () => boolean) => {
    isCurrent = active;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const view = renderHook(
    ({ enabled }) => useDocumentRefresh(enabled, refresh, vi.fn()),
    { initialProps: { enabled: true } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(isCurrent()).toBe(true);
  view.rerender({ enabled: false });
  expect(isCurrent()).toBe(false);
  await act(async () => {
    finish();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("backs off manual review polling and refreshes immediately when the tab returns", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const view = renderHook(() =>
    useDocumentRefresh(true, refresh, vi.fn(), true),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(19_999);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(refresh).toHaveBeenCalledTimes(2);

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(refresh).toHaveBeenCalledTimes(3);
  view.unmount();
});
