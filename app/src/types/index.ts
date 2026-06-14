/**
 * 共享数据类型定义
 * 作为 Frontend / Rust Backend / Python Sidecar 的契约
 */

export type NovelStatus =
  | "imported"
  | "parsing"
  | "embedding"
  | "extracting"
  | "completed"
  | "error";

export interface Novel {
  id: string;
  title: string;
  author?: string;
  sourcePath: string;
  format: "txt" | "epub" | "pdf";
  totalChars: number;
  totalChapters: number;
  status: NovelStatus;
  createdAt: number;
  updatedAt: number;
  progress: ParseProgress;
}

export interface ParseProgress {
  chaptersExtracted: number;
  vectorsIndexed: number;
  entitiesExtracted: number;
}

export interface Chapter {
  novelId: string;
  index: number;
  title: string;
  level: number;
  contentRef: string;
  charCount: number;
  startParagraphIndex: number;
  endParagraphIndex: number;
}

export interface Paragraph {
  id: string;
  novelId: string;
  chapterIndex: number;
  index: number;
  text: string;
  charCount: number;
  vector?: number[];
}

export type EntityType = "person" | "faction" | "item" | "skill" | "location";

export interface EntityMetadata {
  gender?: "male" | "female" | "unknown";
  titles?: string[];
  leader?: string;
  members?: string[];
  itemType?: "weapon" | "pill" | "tome" | "armor" | "misc";
  owner?: string;
  skillType?: "martial" | "cultivation" | "magic" | "misc";
  practitioners?: string[];
  locationType?: "sect" | "city" | "realm" | "misc";
}

export interface Entity {
  id: string;
  novelId: string;
  type: EntityType;
  name: string;
  aliases: string[];
  description: string;
  firstAppearanceChapter?: number;
  metadata: EntityMetadata;
  source: "auto" | "manual" | "merged";
}

export type RelationType =
  | "master_of"
  | "disciple_of"
  | "spouse_of"
  | "sibling_of"
  | "parent_of"
  | "child_of"
  | "ally_of"
  | "enemy_of"
  | "friend_of"
  | "subordinate_of"
  | "superior_of"
  | "belongs_to"
  | "leader_of"
  | "founder_of"
  | "practices"
  | "creator_of"
  | "owns"
  | "uses"
  | "allied_with"
  | "hostile_to"
  | "subordinate_to"
  | "requires"
  | "enhanced_by"
  | "related_to";

export interface Relation {
  id: string;
  novelId: string;
  from: string;
  to: string;
  type: RelationType;
  description?: string;
  chapterIndex?: number;
  source: "auto" | "manual";
}

export interface GraphNode {
  id: string;
  label: string;
  type: EntityType;
  data: Entity;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  type: RelationType;
  data: Relation;
}

export interface SearchResult {
  paragraph: Paragraph;
  score: number;
  chapterTitle: string;
}

export interface Citation {
  paragraphId: string;
  chapterTitle: string;
  snippet: string;
}

export interface ChatMessage {
  id: string;
  novelId: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  citations?: Citation[];
  model?: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  novelId: string;
  title: string;
  messageCount: number;
  updatedAt: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  baseUrl: string;
  modelName: string;
  apiKeyRef?: string;
  isDefault?: boolean;
  temperature?: number;
}

export interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface AppSettings {
  ui: {
    theme: "light" | "dark" | "system";
    language: string;
    fontSize: number;
    fontFamily: string;
    graph: {
      layoutAlgorithm: string;
      nodeSize: number;
      edgeWidth: number;
      colorScheme: string;
      showLabels: boolean;
    };
  };
  window: {
    width: number;
    height: number;
    x: number;
    y: number;
    maximized: boolean;
  };
  parsing: {
    autoStartOnImport: boolean;
    chunkSize: number;
    chunkOverlap: number;
    maxThreads: number;
  };
  embedding: {
    modelPath: string;
    batchSize: number;
    device: string;
  };
  llm: {
    defaultConfigId: string;
    parseModelConfigId: string;
    chatModelConfigId: string;
    maxContextTokens: number;
    temperature: number;
  };
  rag: {
    topK: number;
    enableHybridSearch: boolean;
    rerankEnabled: boolean;
    minRelevanceScore: number;
  };
  sidecar: {
    pythonPath: string;
    logLevel: string;
    healthCheckInterval: number;
  };
}
