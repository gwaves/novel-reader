/**
 * 封装 Tauri listen 的 React Hook
 * 在组件挂载时订阅事件，卸载时自动取消订阅
 */
import { useEffect } from "react";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

export function useTauriEvent<T>(
  eventName: string,
  handler: EventCallback<T>
) {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    const setup = async () => {
      unlisten = await listen<T>(eventName, handler);
    };

    setup();

    return () => {
      unlisten?.();
    };
  }, [eventName, handler]);
}
