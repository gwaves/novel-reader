import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useChatStore } from "../store/novelStore";
import type { ApiResult, ChatMessage, Citation } from "../types";

interface Props {
  novelId: string | null;
}

export default function ChatPanel({ novelId }: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const {
    sessions,
    activeSessionId,
    messages,
    streaming,
    isLoading,
    error,
    loadSessions,
    loadSessionHistory,
    createSession,
    addMessage,
    updateLastMessage,
    setActiveSession,
    setStreaming,
    setError,
  } = useChatStore();

  // 加载会话列表
  useEffect(() => {
    if (!novelId) return;
    loadSessions(novelId);
  }, [novelId, loadSessions]);

  // 切换会话时加载历史消息
  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    loadSessionHistory(activeSessionId);
  }, [activeSessionId, loadSessionHistory]);

  // 监听 chat:stream 事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await listen<{
        requestId: string;
        type: "delta" | "citation" | "done" | "error";
        delta?: string;
        citation?: Citation;
        error?: { code: string; message: string };
      }>("chat:stream", (event) => {
        const { payload } = event;

        if (payload.type === "delta" && payload.delta) {
          updateLastMessage((last) => {
            if (last.role !== "assistant") return last;
            return {
              ...last,
              content: last.content + payload.delta!,
            };
          });
        } else if (payload.type === "citation" && payload.citation) {
          updateLastMessage((last) => {
            if (last.role !== "assistant") return last;
            const citations = last.citations ? [...last.citations, payload.citation!] : [payload.citation!];
            return { ...last, citations };
          });
        } else if (payload.type === "done") {
          setStreaming(false);
        } else if (payload.type === "error") {
          setStreaming(false);
          setError(payload.error?.message || "流式响应出错");
          console.error("Stream error:", payload.error);
        }
      });
    };

    setup();
    return () => {
      unlisten?.();
    };
  }, [updateLastMessage, setStreaming, setError]);

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!novelId || !input.trim() || streaming) return;

    const content = input.trim();
    setInput("");

    // 如果没有活跃会话，先创建一个
    let sessionId = activeSessionId;
    if (!sessionId) {
      const newSession = createSession(novelId, content.slice(0, 20));
      sessionId = newSession.id;
    }

    // 先显示用户消息
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      novelId,
      sessionId: sessionId!,
      role: "user",
      content,
      timestamp: Date.now(),
    };
    addMessage(userMsg);

    setStreaming(true);
    setError(null);

    // 预插入一个空的 assistant 消息，用于流式追加
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      novelId,
      sessionId: sessionId!,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    addMessage(assistantMsg);

    try {
      const res = await invoke<ApiResult<{ message: ChatMessage }>>("chat_stream", {
        novelId,
        message: content,
        sessionId,
      });
      if (!res.success) {
        setStreaming(false);
        setError(res.error?.message || "发送失败");
      }
    } catch (e: any) {
      setStreaming(false);
      setError(e?.message || "发送异常");
    }
  }, [
    novelId,
    input,
    streaming,
    activeSessionId,
    addMessage,
    createSession,
    updateLastMessage,
    setStreaming,
    setError,
  ]);

  const handleNewSession = () => {
    if (!novelId) return;
    createSession(novelId);
  };

  const handleSelectSession = (id: string) => {
    setActiveSession(id);
  };

  return (
    <div className="flex h-full bg-bg-panel">
      {/* 左侧会话列表 */}
      <div className="w-56 border-r border-border flex flex-col bg-bg-base/50">
        <div className="p-3 border-b border-border">
          <button
            onClick={handleNewSession}
            disabled={!novelId}
            className="w-full px-3 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-dark disabled:opacity-50 cursor-pointer transition-colors"
          >
            + 新会话
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {!novelId && (
            <div className="text-xs text-text-muted text-center py-4">
              请先选择小说
            </div>
          )}
          {novelId && sessions.length === 0 && !isLoading && (
            <div className="text-xs text-text-muted text-center py-4">
              暂无会话，点击上方创建
            </div>
          )}
          {sessions.map((session) => (
            <button
              key={session.id}
              onClick={() => handleSelectSession(session.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                activeSessionId === session.id
                  ? "bg-primary/10 text-primary border border-primary/20"
                  : "text-text-main hover:bg-bg-panel border border-transparent"
              }`}
            >
              <div className="truncate font-medium">{session.title}</div>
              <div className="text-xs text-text-muted mt-0.5">
                {session.messageCount} 条消息 ·{" "}
                {new Date(session.updatedAt).toLocaleDateString()}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 右侧聊天区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!novelId && (
            <div className="flex items-center justify-center h-full text-text-muted">
              <div className="text-center">
                <div className="text-4xl mb-4">💬</div>
                <div className="text-lg font-medium">请先选择一本小说</div>
                <div className="text-sm mt-1">选择小说后即可开始问答</div>
              </div>
            </div>
          )}

          {novelId && messages.length === 0 && (
            <div className="flex items-center justify-center h-full text-text-muted">
              <div className="text-center">
                <div className="text-4xl mb-4">🤖</div>
                <div className="text-lg font-medium">开始对话</div>
                <div className="text-sm mt-1">输入问题，AI 将基于小说内容回答</div>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-white"
                    : "bg-bg-base border border-border text-text-main"
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.content}</div>

                {/* 引用来源 */}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border/50">
                    <div className="text-xs text-text-muted mb-1">引用来源：</div>
                    <div className="space-y-1">
                      {msg.citations.map((c, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            // 可扩展：跳转到原文位置
                            console.log("Navigate to citation:", c.paragraphId);
                          }}
                          className="block w-full text-left text-xs text-primary-dark hover:underline cursor-pointer"
                          title="点击跳转到原文"
                        >
                          [{i + 1}] {c.chapterTitle}：{c.snippet.slice(0, 50)}
                          {c.snippet.length > 50 ? "..." : ""}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* 流式响应中的闪烁光标 */}
          {streaming && messages[messages.length - 1]?.role === "assistant" && (
            <div className="flex justify-start">
              <div className="bg-bg-base border border-border rounded-xl px-4 py-2.5 text-sm text-text-muted">
                <span className="inline-block w-1.5 h-4 bg-primary animate-pulse rounded-sm" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="px-4 py-2 bg-red-50 border-t border-red-100 text-xs text-red-600">
            {error}
          </div>
        )}

        {/* 输入框 */}
        <div className="p-4 border-t border-border flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              novelId
                ? activeSessionId
                  ? "输入问题..."
                  : "输入问题以创建新会话..."
                : "请先选择小说"
            }
            disabled={!novelId || streaming}
            className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm focus:outline-none focus:border-primary disabled:bg-bg-base transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={!novelId || !input.trim() || streaming}
            className="px-5 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-dark disabled:opacity-50 cursor-pointer transition-colors"
          >
            {streaming ? "..." : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
