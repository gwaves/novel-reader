import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Novel,
  Entity,
  ChatSession,
  ChatMessage,
  GraphNode,
  GraphEdge,
  ApiResult,
  NovelStatus,
  ParseProgress,
} from "../types";

/** 规范化后端返回的小说数据：处理 progress_json / snake_case */
function normalizeNovel(raw: any): Novel {
  const progress: ParseProgress = raw.progress || (() => {
    try {
      return JSON.parse(raw.progress_json || "{\"chaptersExtracted\":0,\"vectorsIndexed\":0,\"entitiesExtracted\":0}");
    } catch {
      return { chaptersExtracted: 0, vectorsIndexed: 0, entitiesExtracted: 0 };
    }
  })();
  return {
    id: raw.id,
    title: raw.title,
    author: raw.author,
    sourcePath: raw.source_path || raw.sourcePath,
    format: raw.format,
    totalChars: raw.total_chars ?? raw.totalChars ?? 0,
    totalChapters: raw.total_chapters ?? raw.totalChapters ?? 0,
    status: raw.status,
    progress,
    createdAt: raw.created_at ?? raw.createdAt ?? 0,
    updatedAt: raw.updated_at ?? raw.updatedAt ?? 0,
  };
}

// ============================================================
// Novel Store
// ============================================================

interface NovelState {
  novels: Novel[];
  selectedNovelId: string | null;
  isLoading: boolean;
  error: string | null;

  // sync actions
  setNovels: (novels: Novel[]) => void;
  selectNovel: (id: string | null) => void;
  addNovel: (novel: Novel) => void;
  updateNovel: (id: string, updates: Partial<Novel>) => void;
  removeNovel: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // async actions
  fetchNovels: () => Promise<void>;
  importNovel: (filePath: string) => Promise<Novel | null>;
  deleteNovel: (id: string) => Promise<void>;
  reparseNovel: (id: string) => Promise<void>;
}

export const useNovelStore = create<NovelState>((set, get) => ({
  novels: [],
  selectedNovelId: null,
  isLoading: false,
  error: null,

  setNovels: (novels) => set({ novels }),
  selectNovel: (id) => set({ selectedNovelId: id }),
  addNovel: (novel) => set((state) => ({ novels: [novel, ...state.novels] })),
  updateNovel: (id, updates) =>
    set((state) => ({
      novels: state.novels.map((n) => (n.id === id ? { ...n, ...updates } : n)),
    })),
  removeNovel: (id) =>
    set((state) => ({
      novels: state.novels.filter((n) => n.id !== id),
      selectedNovelId: state.selectedNovelId === id ? null : state.selectedNovelId,
    })),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),

  fetchNovels: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await invoke<ApiResult<{ novels: any[] }>>("list_novels");
      if (res.success && res.data) {
        set({ novels: res.data.novels.map(normalizeNovel) });
      } else {
        set({ error: res.error?.message || "获取小说列表失败" });
      }
    } catch (e: any) {
      set({ error: e?.message || "网络错误" });
    } finally {
      set({ isLoading: false });
    }
  },

  importNovel: async (filePath: string) => {
    set({ isLoading: true, error: null });
    try {
      const res = await invoke<ApiResult<{ novel: any }>>("import_novel", {
        filePath,
      });
      if (res.success && res.data) {
        const novel = normalizeNovel(res.data.novel);
        get().addNovel(novel);
        return novel;
      } else {
        set({ error: res.error?.message || "导入失败" });
        return null;
      }
    } catch (e: any) {
      set({ error: e?.message || "导入异常" });
      return null;
    } finally {
      set({ isLoading: false });
    }
  },

  deleteNovel: async (id: string) => {
    try {
      const res = await invoke<ApiResult<unknown>>("delete_novel", { novelId: id });
      if (res.success) {
        get().removeNovel(id);
      } else {
        set({ error: res.error?.message || "删除失败" });
      }
    } catch (e: any) {
      set({ error: e?.message || "删除异常" });
    }
  },

  reparseNovel: async (id: string) => {
    // 重新解析：更新状态为 parsing，触发后端重新处理
    // 后端需要在 Rust 中实现对应 command，这里假设为 reparse_novel
    try {
      const res = await invoke<ApiResult<{ novel: Novel }>>("reparse_novel", {
        novelId: id,
      });
      if (res.success && res.data) {
        get().updateNovel(id, res.data.novel);
      } else {
        set({ error: res.error?.message || "重新解析失败" });
      }
    } catch (e: any) {
      // 如果后端未实现 reparse_novel，降级为仅更新前端状态
      console.warn("reparse_novel not implemented, fallback to local state update");
      get().updateNovel(id, { status: "parsing" as NovelStatus });
    }
  },
}));

// ============================================================
// Graph Store
// ============================================================

interface GraphFilters {
  nodeTypes: string[];
  relationTypes?: string[];
  centerNodeId?: string;
  depth?: number;
  chapterRange?: [number, number];
}

interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedEntity: Entity | null;
  filters: GraphFilters;
  isLoading: boolean;
  error: string | null;

  setSelectedEntity: (entity: Entity | null) => void;
  setFilters: (filters: Partial<GraphFilters>) => void;
  fetchGraphData: (novelId: string, filters?: Partial<GraphFilters>) => Promise<void>;
  clearGraph: () => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedEntity: null,
  filters: {
    nodeTypes: ["person", "faction", "item", "skill", "location"],
  },
  isLoading: false,
  error: null,

  setSelectedEntity: (entity) => set({ selectedEntity: entity }),

  setFilters: (filters) =>
    set((state) => ({
      filters: { ...state.filters, ...filters },
    })),

  fetchGraphData: async (novelId: string, filters?: Partial<GraphFilters>) => {
    const mergedFilters = { ...get().filters, ...filters };
    set({ isLoading: true, error: null });
    try {
      const res = await invoke<ApiResult<{ nodes: GraphNode[]; edges: GraphEdge[] }>>(
        "get_graph_data",
        {
          novelId,
          nodeTypes: mergedFilters.nodeTypes,
          relationTypes: mergedFilters.relationTypes,
          centerNodeId: mergedFilters.centerNodeId,
          depth: mergedFilters.depth,
          chapterRange: mergedFilters.chapterRange,
        }
      );
      if (res.success && res.data) {
        set({ nodes: res.data.nodes, edges: res.data.edges });
      } else {
        set({ error: res.error?.message || "获取图谱数据失败" });
      }
    } catch (e: any) {
      set({ error: e?.message || "网络错误" });
    } finally {
      set({ isLoading: false });
    }
  },

  clearGraph: () => set({ nodes: [], edges: [], selectedEntity: null }),
}));

// ============================================================
// Chat Store
// ============================================================

interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  messages: ChatMessage[];
  isLoading: boolean;
  streaming: boolean;
  error: string | null;

  setSessions: (sessions: ChatSession[]) => void;
  setActiveSession: (id: string | null) => void;
  addMessage: (msg: ChatMessage) => void;
  updateLastMessage: (updater: (msg: ChatMessage) => ChatMessage) => void;
  setLoading: (loading: boolean) => void;
  setStreaming: (streaming: boolean) => void;
  setError: (error: string | null) => void;

  loadSessions: (novelId: string) => Promise<void>;
  loadSessionHistory: (sessionId: string) => Promise<void>;
  createSession: (novelId: string, title?: string) => ChatSession;
  sendMessage: (novelId: string, content: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  isLoading: false,
  streaming: false,
  error: null,

  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
  updateLastMessage: (updater) =>
    set((state) => {
      if (state.messages.length === 0) return state;
      const updated = [...state.messages];
      updated[updated.length - 1] = updater(updated[updated.length - 1]);
      return { messages: updated };
    }),
  setLoading: (isLoading) => set({ isLoading }),
  setStreaming: (streaming) => set({ streaming }),
  setError: (error) => set({ error }),

  loadSessions: async (novelId: string) => {
    set({ isLoading: true, error: null });
    try {
      const res = await invoke<ApiResult<{ sessions: ChatSession[] }>>(
        "list_sessions",
        { novelId }
      );
      if (res.success && res.data) {
        set({ sessions: res.data.sessions });
      } else {
        set({ error: res.error?.message || "获取会话列表失败" });
      }
    } catch (e: any) {
      set({ error: e?.message || "网络错误" });
    } finally {
      set({ isLoading: false });
    }
  },

  loadSessionHistory: async (sessionId: string) => {
    set({ isLoading: true, error: null, messages: [] });
    try {
      const res = await invoke<ApiResult<{ messages: ChatMessage[] }>>(
        "get_session_history",
        { sessionId }
      );
      if (res.success && res.data) {
        set({ messages: res.data.messages });
      } else {
        set({ error: res.error?.message || "获取会话历史失败" });
      }
    } catch (e: any) {
      set({ error: e?.message || "网络错误" });
    } finally {
      set({ isLoading: false });
    }
  },

  createSession: (novelId: string, title?: string) => {
    const session: ChatSession = {
      id: crypto.randomUUID(),
      novelId,
      title: title || "新会话",
      messageCount: 0,
      updatedAt: Date.now(),
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      activeSessionId: session.id,
      messages: [],
    }));
    return session;
  },

  sendMessage: async (novelId: string, content: string) => {
    const state = get();
    let sessionId = state.activeSessionId;

    // 如果没有活跃会话，自动创建一个
    if (!sessionId) {
      const newSession = get().createSession(novelId, content.slice(0, 20));
      sessionId = newSession.id;
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      novelId,
      sessionId: sessionId!,
      role: "user",
      content,
      timestamp: Date.now(),
    };

    get().addMessage(userMsg);
    set({ streaming: true, error: null });

    try {
      const res = await invoke<ApiResult<{ message: ChatMessage }>>("chat_stream", {
        novelId,
        message: content,
        sessionId,
      });
      if (res.success && res.data) {
        get().addMessage(res.data.message);
      } else {
        set({ error: res.error?.message || "发送失败", streaming: false });
      }
    } catch (e: any) {
      set({ error: e?.message || "发送异常", streaming: false });
    }
  },
}));

// ============================================================
// Sidecar / App Status Store
// ============================================================

interface AppStatusState {
  sidecarStatus: "idle" | "starting" | "running" | "error" | "stopped";
  sidecarMessage: string | null;
  setSidecarStatus: (status: AppStatusState["sidecarStatus"], message?: string) => void;
}

export const useAppStatusStore = create<AppStatusState>((set) => ({
  sidecarStatus: "idle",
  sidecarMessage: null,
  setSidecarStatus: (sidecarStatus, sidecarMessage) => set({ sidecarStatus, sidecarMessage }),
}));

// ============================================================
// 全局解析进度监听（在应用入口处启动一次即可）
// ============================================================

let progressUnlisten: (() => void) | null = null;

export async function startParseProgressListener() {
  if (progressUnlisten) return;
  progressUnlisten = await listen<{
    novelId: string;
    status: NovelStatus;
    progress: ParseProgress;
    message?: string;
  }>("novel:parse-progress", (event) => {
    const { novelId, status, progress } = event.payload;
    useNovelStore.getState().updateNovel(novelId, { status, progress });
  });
}

export function stopParseProgressListener() {
  progressUnlisten?.();
  progressUnlisten = null;
}
