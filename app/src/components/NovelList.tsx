import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useNovelStore } from "../store/novelStore";
import type { NovelStatus } from "../types";

/** 判断小说是否处于解析中状态 */
function isParsing(status: NovelStatus): boolean {
  return status === "parsing" || status === "embedding" || status === "extracting";
}

/** 状态标签映射 */
const STATUS_LABELS: Record<NovelStatus, string> = {
  imported: "已导入",
  parsing: "解析中",
  embedding: "向量化中",
  extracting: "提取实体中",
  completed: "已完成",
  error: "错误",
};

/** 解析进度计算 */
function calcProgress(novel: { status: NovelStatus; progress?: { chaptersExtracted: number; vectorsIndexed: number; entitiesExtracted: number }; totalChapters: number }): number {
  if (!isParsing(novel.status)) return 100;
  const progress = novel.progress || { chaptersExtracted: 0, vectorsIndexed: 0, entitiesExtracted: 0 };
  // 简单估算：假设解析分三个阶段各占 1/3
  const chapterRatio = novel.totalChapters > 0 ? progress.chaptersExtracted / novel.totalChapters : 0;
  const vectorRatio = novel.totalChapters > 0 ? progress.vectorsIndexed / novel.totalChapters : 0;
  const entityRatio = novel.totalChapters > 0 ? progress.entitiesExtracted / novel.totalChapters : 0;
  const avg = (chapterRatio + vectorRatio + entityRatio) / 3;
  return Math.min(Math.round(avg * 100), 99);
}

/** 持久化日志 */
const LOG_KEY = "novelreader_novel_logs";
function readLogs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
  } catch {
    return [];
  }
}
function writeLogs(logs: string[]) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(logs.slice(-50)));
  } catch {
    // ignore
  }
}

export default function NovelList() {
  const {
    novels,
    selectedNovelId,
    isLoading,
    fetchNovels,
    importNovel,
    deleteNovel,
    selectNovel,
    reparseNovel,
  } = useNovelStore();

  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [logs, setLogs] = useState<string[]>(readLogs());

  const addLog = (msg: string) => {
    const entry = `${new Date().toLocaleTimeString()} ${msg}`;
    setLogs((prev) => {
      const next = [...prev, entry];
      writeLogs(next);
      return next;
    });
  };

  const clearLogs = () => {
    setLogs([]);
    localStorage.removeItem(LOG_KEY);
  };

  useEffect(() => {
    addLog("[NovelList] MOUNTED");
    fetchNovels();
  }, [fetchNovels]);

  // 解析中自动轮询进度
  useEffect(() => {
    const interval = setInterval(() => {
      const currentlyParsing = useNovelStore.getState().novels.some((n) => isParsing(n.status));
      if (currentlyParsing) {
        addLog("[NovelList] polling fetchNovels");
        fetchNovels();
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [fetchNovels]);

  // Tauri 原生拖拽事件监听
  useEffect(() => {
    let unlistenDrop: (() => void) | undefined;
    let unlistenOver: (() => void) | undefined;
    let unlistenLeave: (() => void) | undefined;

    const setup = async () => {
      addLog("[DragDrop] setting up listeners...");
      try {
        unlistenDrop = await listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
          addLog("[DragDrop] tauri://drag-drop received");
          setDragOver(false);
          const paths = event.payload.paths;
          addLog(`[DragDrop] paths: ${JSON.stringify(paths)}`);
          const validPath = paths.find((p) =>
            [".txt", ".epub", ".pdf"].some((ext) => p.toLowerCase().endsWith(ext))
          );
          if (validPath) {
            addLog(`[DragDrop] validPath: ${validPath}`);
            setImporting(true);
            try {
              await importNovel(validPath);
              addLog("[DragDrop] importNovel success");
            } catch (e: any) {
              addLog(`[DragDrop] importNovel error: ${e?.message || String(e)}`);
              alert(`导入失败: ${e?.message || String(e)}`);
            } finally {
              setImporting(false);
            }
          } else {
            addLog("[DragDrop] no valid path found");
          }
        });
        addLog("[DragDrop] tauri://drag-drop listener registered");

        unlistenOver = await listen("tauri://drag-over", () => {
          addLog("[DragDrop] tauri://drag-over");
          setDragOver(true);
        });

        unlistenLeave = await listen("tauri://drag-leave", () => {
          addLog("[DragDrop] tauri://drag-leave");
          setDragOver(false);
        });
      } catch (e: any) {
        addLog(`[DragDrop] setup error: ${e?.message || String(e)}`);
      }
    };

    setup();
    return () => {
      addLog("[NovelList] UNMOUNTED");
      unlistenDrop?.();
      unlistenOver?.();
      unlistenLeave?.();
    };
  }, [importNovel]);

  const handleImportClick = async () => {
    addLog("[ImportClick] BUTTON CLICKED");
    try {
      addLog("[ImportClick] opening dialog...");
      const file = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Novel Files", extensions: ["txt", "epub", "pdf"] }],
      });
      addLog(`[ImportClick] dialog result: ${JSON.stringify(file)}`);
      if (file && typeof file === "string") {
        setImporting(true);
        try {
          await importNovel(file);
          addLog("[ImportClick] importNovel success");
        } catch (e: any) {
          addLog(`[ImportClick] importNovel error: ${e?.message || String(e)}`);
          alert(`导入失败: ${e?.message || String(e)}`);
        } finally {
          setImporting(false);
        }
      } else if (file === null) {
        addLog("[ImportClick] user cancelled dialog");
      } else {
        addLog(`[ImportClick] unexpected result: ${JSON.stringify(file)}`);
      }
    } catch (e: any) {
      addLog(`[ImportClick] dialog error: ${e?.message || String(e)}`);
      console.error("[Import] dialog error:", e);
      alert(`打开文件对话框失败: ${e?.message || String(e)}`);
    }
  };

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`确定要删除《${title}》吗？此操作不可恢复。`)) return;
    await deleteNovel(id);
  };

  const handleReparse = async (id: string) => {
    if (!confirm("确定要重新解析这本小说吗？")) return;
    await reparseNovel(id);
  };

  return (
    <div
      className={`flex flex-col h-full p-4 transition-colors ${
        dragOver ? "bg-primary/5" : ""
      }`}
    >
      {/* 无条件调试块：只要 NovelList 被渲染就一定可见 */}
      <div className="mb-2 p-2 bg-red-700 text-white text-xs rounded font-mono">
        [DEBUG] NovelList rendered | logs={logs.length} | isLoading={String(isLoading)} | importing={String(importing)} | novels={novels.length}
      </div>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-text-main">我的小说</h2>
        <button
          onClick={handleImportClick}
          disabled={isLoading || importing}
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark disabled:opacity-50 cursor-pointer transition-colors"
        >
          {isLoading || importing ? "导入中..." : "导入小说"}
        </button>
      </div>

      {/* 持久化日志显示区 */}
      {logs.length > 0 && (
        <div className="mb-4 p-2 bg-gray-900 text-green-400 text-xs rounded border border-gray-700 font-mono max-h-40 overflow-auto">
          <div className="flex justify-between items-center mb-1">
            <span className="font-bold text-gray-300">NovelList 日志</span>
            <button
              onClick={() => clearLogs()}
              className="text-gray-500 hover:text-white text-xs cursor-pointer"
            >
              清除
            </button>
          </div>
          {logs.map((log, i) => (
            <div key={i} className="truncate">{log}</div>
          ))}
        </div>
      )}

      {/* 拖拽提示 */}
      {dragOver && (
        <div className="mb-3 p-3 border-2 border-dashed border-primary rounded-lg text-center text-primary text-sm">
          释放文件以导入
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-2">
        {novels.map((novel) => {
          const selected = selectedNovelId === novel.id;
          const parsing = isParsing(novel.status);
          const progress = calcProgress(novel);

          return (
            <div
              key={novel.id}
              onClick={() => selectNovel(novel.id)}
              className={`relative p-3 rounded-lg border cursor-pointer transition-colors group ${
                selected
                  ? "border-primary bg-blue-50"
                  : "border-border bg-bg-panel hover:border-primary/50"
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-text-main truncate">
                    {novel.title}
                  </div>
                  <div className="text-sm text-text-muted mt-1">
                    {novel.format.toUpperCase()} · {novel.totalChars.toLocaleString()} 字 ·{" "}
                    {novel.totalChapters} 章
                  </div>
                  <div className="text-xs text-text-muted mt-1">
                    状态:{" "}
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                        novel.status === "completed"
                          ? "bg-green-100 text-green-700"
                          : novel.status === "error"
                          ? "bg-red-100 text-red-700"
                          : parsing
                          ? "bg-blue-100 text-blue-700"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {STATUS_LABELS[novel.status]}
                    </span>
                  </div>
                </div>

                {/* 操作按钮组 */}
                <div className="flex flex-col gap-1 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReparse(novel.id);
                    }}
                    className="px-2 py-1 text-xs border border-border rounded hover:bg-bg-base text-text-muted cursor-pointer"
                    title="重新解析"
                  >
                    重新解析
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(novel.id, novel.title);
                    }}
                    className="px-2 py-1 text-xs border border-red-200 rounded hover:bg-red-50 text-red-500 cursor-pointer"
                    title="删除"
                  >
                    删除
                  </button>
                </div>
              </div>

              {/* 解析进度条 */}
              {parsing && (
                <div className="mt-2">
                  <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-primary h-1.5 rounded-full transition-all duration-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <div className="text-xs text-text-muted mt-0.5">
                    进度: {progress}%（章节 {novel.progress?.chaptersExtracted ?? 0} / 向量{" "}
                    {novel.progress?.vectorsIndexed ?? 0} / 实体 {novel.progress?.entitiesExtracted ?? 0}）
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {novels.length === 0 && !isLoading && (
          <div className="text-center text-text-muted py-12">
            <div className="mb-2">暂无小说</div>
            <div className="text-sm">点击右上角导入，或将文件拖拽到此处</div>
          </div>
        )}
      </div>
    </div>
  );
}
