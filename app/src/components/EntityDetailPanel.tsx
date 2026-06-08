import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Entity, Relation, ApiResult } from "../types";

interface Props {
  entity: Entity | null;
  open: boolean;
  onClose: () => void;
  onNavigate: (entityId: string) => void;
}

/** 关系类型中文映射 */
const RELATION_LABELS: Record<string, string> = {
  master_of: "师父",
  disciple_of: "徒弟",
  spouse_of: "配偶",
  sibling_of: "兄弟姐妹",
  parent_of: "父母",
  child_of: "子女",
  ally_of: "盟友",
  enemy_of: "仇敌",
  friend_of: "朋友",
  subordinate_of: "下属",
  superior_of: "上司",
  belongs_to: "属于",
  leader_of: "领袖",
  founder_of: "创立者",
  practices: "修炼",
  creator_of: "创造者",
  owns: "拥有",
  uses: "使用",
  allied_with: "结盟",
  hostile_to: "敌对",
  subordinate_to: "从属于",
  requires: "需要",
  enhanced_by: "增强",
  related_to: "相关",
};

/** 实体类型中文映射 */
const ENTITY_TYPE_LABELS: Record<string, string> = {
  person: "人物",
  faction: "派系",
  item: "道具",
  skill: "功法",
  location: "地点",
};

interface EntityDetailData {
  entity: Entity;
  relations: Relation[];
  relatedEntities: Record<string, Entity>;
}

export default function EntityDetailPanel({
  entity,
  open,
  onClose,
  onNavigate,
}: Props) {
  const [detail, setDetail] = useState<EntityDetailData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!entity) {
      setDetail(null);
      return;
    }

    const load = async () => {
      setLoading(true);
      try {
        const res = await invoke<ApiResult<EntityDetailData>>("get_entity_detail", {
          novelId: entity.novelId,
          entityId: entity.id,
        });
        if (res.success && res.data) {
          setDetail(res.data);
        }
      } catch (e) {
        console.error("Failed to load entity detail:", e);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [entity]);

  if (!open || !entity) return null;

  // 按关系类型分组
  const groupedRelations: Record<string, { relation: Relation; target: Entity | undefined }[]> = {};
  if (detail) {
    detail.relations.forEach((rel) => {
      const isFrom = rel.from === entity.id;
      const targetId = isFrom ? rel.to : rel.from;
      const target = detail.relatedEntities[targetId];
      const key = rel.type;
      if (!groupedRelations[key]) groupedRelations[key] = [];
      groupedRelations[key].push({ relation: rel, target });
    });
  }

  return (
    <div className="w-80 bg-bg-panel border-l border-border flex flex-col h-full shadow-lg animate-in slide-in-from-right duration-200">
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h3 className="font-semibold text-text-main truncate pr-2">{entity.name}</h3>
        <button
          onClick={onClose}
          className="text-text-muted hover:text-text-main cursor-pointer text-lg leading-none"
          title="关闭"
        >
          ×
        </button>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="text-sm text-text-muted">加载中...</div>
        )}

        {/* 基础信息 */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary font-medium">
              {ENTITY_TYPE_LABELS[entity.type] || entity.type}
            </span>
            {entity.source === "manual" && (
              <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">
                手动添加
              </span>
            )}
          </div>

          {entity.aliases && entity.aliases.length > 0 && (
            <div className="text-sm text-text-muted">
              <span className="font-medium text-text-main">别名：</span>
              {entity.aliases.join("、")}
            </div>
          )}

          {entity.firstAppearanceChapter !== undefined && (
            <div className="text-sm text-text-muted">
              <span className="font-medium text-text-main">首次出场：</span>
              第 {entity.firstAppearanceChapter} 章
            </div>
          )}

          {entity.description && (
            <div className="text-sm text-text-main leading-relaxed bg-bg-base rounded-lg p-3 border border-border">
              {entity.description}
            </div>
          )}
        </div>

        {/* 关系列表 */}
        {detail && Object.keys(groupedRelations).length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-text-main mb-2">关联关系</h4>
            <div className="space-y-3">
              {Object.entries(groupedRelations).map(([type, items]) => (
                <div key={type}>
                  <div className="text-xs font-medium text-text-muted mb-1">
                    {RELATION_LABELS[type] || type}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {items.map(({ target }, idx) =>
                      target ? (
                        <button
                          key={idx}
                          onClick={() => onNavigate(target.id)}
                          className="text-xs px-2 py-1 rounded border border-border bg-bg-base hover:border-primary hover:text-primary transition-colors cursor-pointer"
                        >
                          {target.name}
                        </button>
                      ) : (
                        <span
                          key={idx}
                          className="text-xs px-2 py-1 rounded border border-border bg-bg-base text-text-muted"
                        >
                          未知实体
                        </span>
                      )
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {detail && Object.keys(groupedRelations).length === 0 && (
          <div className="text-sm text-text-muted">暂无关联关系</div>
        )}
      </div>
    </div>
  );
}
