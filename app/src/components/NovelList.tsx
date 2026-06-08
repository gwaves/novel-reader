import { useEffect, useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
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
function calcProgress(novel: { status: NovelStatus; progress: { chaptersExtracted: number; vectorsIndexed: number; entitiesExtracted: number }; totalChapters: number }): number {
  if (!isParsing(novel.status)) return 100;
  // 简单估算：假设解析分三个阶段各占 1/3
  const chapterRatio = novel.totalChapters > 0 ? novel.progress.chaptersExtracted / novel.totalChapters : 0;
  const vectorRatio = novel.totalChapters > 0 ? novel.progress.vectorsIndexed / novel.totalChapters : 0;
  const entityRatio = novel.totalChapters > 0 ? novel.progress.entitiesExtracted / novel.totalChapters : 0;
  const avg = (chapterRatio + vectorRatio + entityRatio) / 3;
  return Math.min(Math.round(avg * 100), 99);
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

  useEffect(() => {
    fetchNovels();
  }, [fetchNovels]);

  const handleImportClick = async () => {
    const file = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Novel Files", extensions: ["txt", "epub", "pdf"] }],
    });
    if (file && typeof file === "string") {
      setImporting(true);
      await importNovel(file);
      setImporting(false);
    }
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      const validFile = files.find((f) =>
        ["txt", "epub", "pdf"].includes(f.name.split(".").pop()?.toLowerCase() || "")
      );
      if (validFile) {
        // 在 Tauri 中，拖拽文件的路径可以通过 Tauri API 获取，
        // 但 HTML5 drag 的 File 对象在 Webview 中可能无法直接拿到绝对路径。
        // 这里假设使用 Tauri 的 dialog open 作为兜底，或者前端通过其他方式传递路径。
        // 为了演示，我们尝试使用 webkitGetAsEntry 或 path 属性（Tauri 环境下通常可用）
        const path = (validFile as any).path as string | undefined;
        if (path) {
          setImporting(true);
          await importNovel(path);
          setImporting(false);
        }
      }
    },
    [importNovel]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
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
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
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
                    进度: {progress}%（章节 {novel.progress.chaptersExtracted} / 向量{" "}
                    {novel.progress.vectorsIndexed} / 实体 {novel.progress.entitiesExtracted}）
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
