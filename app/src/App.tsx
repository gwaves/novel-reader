import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNovelStore, useAppStatusStore, startParseProgressListener } from "./store/novelStore";
import NovelList from "./components/NovelList";
import GraphView from "./components/GraphView";
import ChatPanel from "./components/ChatPanel";
import SettingsPanel from "./components/SettingsPanel";

type Tab = "novels" | "graph" | "chat" | "settings";

const tabs: { key: Tab; label: string; icon: string }[] = [
  { key: "novels", label: "小说", icon: "📚" },
  { key: "graph", label: "图谱", icon: "🕸️" },
  { key: "chat", label: "问答", icon: "💬" },
  { key: "settings", label: "设置", icon: "⚙️" },
];

function App() {
  const { selectedNovelId } = useNovelStore();
  const { sidecarStatus, sidecarMessage, setSidecarStatus } = useAppStatusStore();
  const [currentTab, setCurrentTab] = useStateWithHash<Tab>("novels");

  // 启动全局解析进度监听
  useEffect(() => {
    startParseProgressListener();
  }, []);

  // 全局错误监听
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await listen<{
        code: string;
        message: string;
        detail?: string;
      }>("app:error", (event) => {
        const { code, message, detail } = event.payload;
        console.error(`[App Error ${code}]`, message, detail);
        // 使用 alert 作为简单 toast；可替换为更美观的 toast 库
        alert(`错误 [${code}]\n${message}${detail ? "\n" + detail : ""}`);
      });
    };

    setup();
    return () => {
      unlisten?.();
    };
  }, []);

  // Sidecar 状态监听
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await listen<{
        status: "idle" | "starting" | "running" | "error" | "stopped";
        message?: string;
      }>("sidecar:status-change", (event) => {
        const { status, message } = event.payload;
        setSidecarStatus(status, message);
      });
    };

    setup();
    return () => {
      unlisten?.();
    };
  }, [setSidecarStatus]);

  return (
    <div className="flex h-screen w-screen bg-bg-base overflow-hidden">
      {/* Sidebar */}
      <aside className="w-16 flex-shrink-0 bg-bg-panel border-r border-border flex flex-col items-center py-4 gap-2 z-10">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setCurrentTab(t.key)}
            className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center text-xs font-medium transition-colors cursor-pointer ${
              currentTab === t.key
                ? "bg-primary text-white shadow-sm"
                : "text-text-muted hover:bg-bg-base hover:text-text-main"
            }`}
            title={t.label}
          >
            <span className="text-base leading-none mb-0.5">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        <div className="flex-1 overflow-hidden">
          {currentTab === "novels" && <NovelList />}
          {currentTab === "graph" && <GraphView novelId={selectedNovelId} />}
          {currentTab === "chat" && <ChatPanel novelId={selectedNovelId} />}
          {currentTab === "settings" && <SettingsPanel />}
        </div>

        {/* 底部状态栏 */}
        <div className="h-7 bg-bg-panel border-t border-border flex items-center px-3 text-xs text-text-muted select-none">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                sidecarStatus === "running"
                  ? "bg-green-500"
                  : sidecarStatus === "error"
                  ? "bg-red-500"
                  : sidecarStatus === "starting"
                  ? "bg-yellow-400 animate-pulse"
                  : "bg-gray-400"
              }`}
            />
            <span>
              Sidecar:
              {sidecarStatus === "idle" && " 空闲"}
              {sidecarStatus === "starting" && " 启动中..."}
              {sidecarStatus === "running" && " 运行中"}
              {sidecarStatus === "error" && " 出错"}
              {sidecarStatus === "stopped" && " 已停止"}
            </span>
            {sidecarMessage && (
              <span className="text-text-muted/70">· {sidecarMessage}</span>
            )}
          </div>
          <div className="ml-auto">
            {selectedNovelId ? (
              <span className="text-text-muted/70">已选择小说</span>
            ) : (
              <span className="text-text-muted/50">未选择小说</span>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/** 使用 hash 同步 tab 状态的 hook */
function useStateWithHash<T extends string>(defaultValue: T): [T, (val: T) => void] {
  const [state, setState] = useState<T>(() => {
    const hash = window.location.hash.replace("#", "") as T;
    return hash || defaultValue;
  });

  useEffect(() => {
    const handler = () => {
      const hash = window.location.hash.replace("#", "") as T;
      if (hash) setState(hash);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const setHashState = (val: T) => {
    window.location.hash = val;
    setState(val);
  };

  return [state, setHashState];
}

export default App;
