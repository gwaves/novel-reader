import { useEffect, useRef, useState, useCallback } from "react";
import cytoscape from "cytoscape";
import { useGraphStore } from "../store/novelStore";
import type { EntityType, GraphNode, Entity } from "../types";
import EntityDetailPanel from "./EntityDetailPanel";

const TYPE_COLORS: Record<EntityType, string> = {
  person: "#3b82f6",
  faction: "#10b981",
  item: "#f59e0b",
  skill: "#8b5cf6",
  location: "#ef4444",
};

/** 关系类型 -> 边颜色 */
const RELATION_EDGE_COLORS: Record<string, string> = {
  enemy_of: "#ef4444",
  hostile_to: "#ef4444",
  ally_of: "#22c55e",
  allied_with: "#22c55e",
  friend_of: "#22c55e",
  master_of: "#3b82f6",
  disciple_of: "#3b82f6",
  parent_of: "#a855f7",
  child_of: "#a855f7",
  spouse_of: "#ec4899",
  sibling_of: "#f59e0b",
  subordinate_of: "#64748b",
  superior_of: "#64748b",
  belongs_to: "#14b8a6",
  leader_of: "#14b8a6",
  founder_of: "#14b8a6",
  practices: "#6366f1",
  creator_of: "#6366f1",
  owns: "#0ea5e9",
  uses: "#0ea5e9",
  requires: "#84cc16",
  enhanced_by: "#84cc16",
  related_to: "#94a3b8",
};

const ALL_NODE_TYPES: EntityType[] = [
  "person",
  "faction",
  "item",
  "skill",
  "location",
];

interface Props {
  novelId: string | null;
}

export default function GraphView({ novelId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  const {
    nodes,
    edges,
    selectedEntity,
    filters,
    isLoading,
    fetchGraphData,
    setSelectedEntity,
    setFilters,
    clearGraph,
  } = useGraphStore();

  const [detailOpen, setDetailOpen] = useState(false);

  // 初始化 Cytoscape 实例
  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            width: 40,
            height: 40,
            "background-color": "data(color)",
            "border-width": 2,
            "border-color": "#fff",
            color: "#1e293b",
            "font-size": "12px",
            "text-valign": "bottom",
            "text-halign": "center",
            "text-margin-y": 4,
            "text-background-color": "#fff",
            "text-background-opacity": 0.8,
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
          },
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "data(edgeColor)",
            "target-arrow-color": "data(edgeColor)",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": "10px",
            color: "#64748b",
            "text-background-color": "#fff",
            "text-background-opacity": 0.8,
            "text-background-padding": "2px",
          },
        },
        {
          selector: ":selected",
          style: {
            "border-width": 4,
            "border-color": "#f59e0b",
          },
        },
      ],
      layout: { name: "grid" } as any,
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.3,
    });

    cy.on("tap", "node", (evt) => {
      const nodeData = evt.target.data() as GraphNode & { rawEntity: Entity };
      setSelectedEntity(nodeData.rawEntity);
      setDetailOpen(true);
    });

    cy.on("tap", (evt) => {
      if (evt.target === cy) {
        setSelectedEntity(null);
        setDetailOpen(false);
      }
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [setSelectedEntity]);

  // 加载图谱数据
  useEffect(() => {
    if (!novelId) {
      clearGraph();
      cyRef.current?.elements().remove();
      return;
    }
    fetchGraphData(novelId, { nodeTypes: filters.nodeTypes });
  }, [novelId, filters.nodeTypes, fetchGraphData, clearGraph]);

  // 数据变化时同步到 Cytoscape
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.elements().remove();

    if (nodes.length === 0) return;

    // 按派系聚类着色：收集所有 faction 节点颜色
    const factionColors: Record<string, string> = {};
    let colorIdx = 0;
    const palette = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#14b8a6", "#ec4899"];

    // 先遍历边，找到 belongs_to / leader_of 等关联到 faction 的关系
    edges.forEach((e) => {
      const targetNode = nodes.find((n) => n.id === e.target);
      if (targetNode?.type === "faction" && !factionColors[targetNode.id]) {
        factionColors[targetNode.id] = palette[colorIdx % palette.length];
        colorIdx++;
      }
    });

    // 节点颜色映射：如果节点属于某个 faction，使用 faction 颜色；否则使用类型默认色
    const nodeColorMap: Record<string, string> = {};
    nodes.forEach((n) => {
      // 查找该节点是否有 belongs_to / leader_of 指向 faction
      const factionEdge = edges.find(
        (e) =>
          e.source === n.id &&
          (e.type === "belongs_to" || e.type === "leader_of" || e.type === "founder_of") &&
          nodes.find((nn) => nn.id === e.target)?.type === "faction"
      );
      if (factionEdge) {
        const factionId = factionEdge.target;
        nodeColorMap[n.id] = factionColors[factionId] || TYPE_COLORS[n.type];
      } else {
        nodeColorMap[n.id] = TYPE_COLORS[n.type] || "#94a3b8";
      }
    });

    cy.add(
      nodes.map((n) => ({
        data: {
          id: n.id,
          label: n.label,
          color: nodeColorMap[n.id],
          type: n.type,
          rawEntity: n.data,
        },
      }))
    );

    cy.add(
      edges.map((e) => ({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          type: e.type,
          edgeColor: RELATION_EDGE_COLORS[e.type] || "#cbd5e1",
          rawRelation: e.data,
        },
      }))
    );

    cy.layout({ name: "cose", animate: true, padding: 20, componentSpacing: 80 } as any).run();
  }, [nodes, edges]);

  const handleZoomIn = useCallback(() => {
    cyRef.current?.zoom(cyRef.current.zoom() * 1.2);
  }, []);

  const handleZoomOut = useCallback(() => {
    cyRef.current?.zoom(cyRef.current.zoom() / 1.2);
  }, []);

  const handleReset = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.fit(cy.elements(), 40);
    cy.center();
  }, []);

  const toggleNodeType = (type: EntityType) => {
    const next = filters.nodeTypes.includes(type)
      ? filters.nodeTypes.filter((t) => t !== type)
      : [...filters.nodeTypes, type];
    setFilters({ nodeTypes: next });
  };

  if (!novelId) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <div className="text-center">
          <div className="text-4xl mb-4">📚</div>
          <div className="text-lg font-medium">请先选择一本小说</div>
          <div className="text-sm mt-1">在左侧"小说"标签页中选择一本小说以查看关系图谱</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full relative">
      {/* 图谱画布 */}
      <div className="flex-1 relative">
        <div ref={containerRef} className="w-full h-full bg-bg-base" />

        {/* 节点类型过滤器 */}
        <div className="absolute top-4 left-4 bg-bg-panel/90 backdrop-blur border border-border rounded-lg p-3 shadow-sm">
          <div className="text-xs font-medium text-text-muted mb-2">节点类型</div>
          <div className="flex flex-col gap-1.5">
            {ALL_NODE_TYPES.map((type) => (
              <label
                key={type}
                className="flex items-center gap-2 text-sm text-text-main cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={filters.nodeTypes.includes(type)}
                  onChange={() => toggleNodeType(type)}
                  className="rounded border-border text-primary focus:ring-primary"
                />
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block"
                  style={{ backgroundColor: TYPE_COLORS[type] }}
                />
                <span className="capitalize">
                  {type === "person" && "人物"}
                  {type === "faction" && "派系"}
                  {type === "item" && "道具"}
                  {type === "skill" && "功法"}
                  {type === "location" && "地点"}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* 控制按钮 */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-2">
          <button
            onClick={handleZoomIn}
            className="w-9 h-9 bg-bg-panel border border-border rounded-lg flex items-center justify-center text-text-main hover:bg-bg-base shadow-sm cursor-pointer"
            title="放大"
          >
            +
          </button>
          <button
            onClick={handleZoomOut}
            className="w-9 h-9 bg-bg-panel border border-border rounded-lg flex items-center justify-center text-text-main hover:bg-bg-base shadow-sm cursor-pointer"
            title="缩小"
          >
            −
          </button>
          <button
            onClick={handleReset}
            className="w-9 h-9 bg-bg-panel border border-border rounded-lg flex items-center justify-center text-text-main hover:bg-bg-base shadow-sm cursor-pointer"
            title="重置视图"
          >
            ⌖
          </button>
        </div>

        {/* 加载状态 */}
        {isLoading && (
          <div className="absolute inset-0 bg-bg-base/50 flex items-center justify-center pointer-events-none">
            <div className="text-text-muted text-sm">加载图谱中...</div>
          </div>
        )}
      </div>

      {/* 实体详情面板 */}
      <EntityDetailPanel
        entity={selectedEntity}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onNavigate={(entityId) => {
          // 在图谱中高亮目标节点
          const cy = cyRef.current;
          if (!cy) return;
          const target = cy.getElementById(entityId);
          if (target.length) {
            target.select();
            cy.animate({
              fit: { eles: target, padding: 80 },
              duration: 400,
              easing: "ease-in-out-cubic",
            });
          }
        }}
      />
    </div>
  );
}
