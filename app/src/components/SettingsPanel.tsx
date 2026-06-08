import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ApiResult, ModelConfig } from "../types";

export default function SettingsPanel() {
  const [configs, setConfigs] = useState<ModelConfig[]>([]);
  const [editing, setEditing] = useState<Partial<ModelConfig> | null>(null);

  const loadConfigs = async () => {
    try {
      const res = await invoke<ApiResult<{ configs: ModelConfig[] }>>(
        "list_model_configs"
      );
      if (res.success && res.data) {
        setConfigs(res.data.configs);
      }
    } catch (e) {
      console.error("Failed to load configs:", e);
    }
  };

  useEffect(() => {
    loadConfigs();
  }, []);

  const handleSave = async () => {
    if (!editing?.name || !editing?.baseUrl || !editing?.modelName) return;
    try {
      await invoke<ApiResult<unknown>>("upsert_model_config", {
        config: {
          ...editing,
          id: editing.id || crypto.randomUUID(),
        },
      });
      setEditing(null);
      loadConfigs();
    } catch (e) {
      console.error("Save failed:", e);
    }
  };

  const handleTest = async (configId: string) => {
    try {
      const res = await invoke<
        ApiResult<{ success: boolean; latency: number }>
      >("test_model_connection", { configId });
      alert(
        res.success && res.data?.success
          ? `连接成功，延迟 ${res.data.latency}ms`
          : "连接失败"
      );
    } catch (e) {
      alert("测试失败: " + e);
    }
  };

  return (
    <div className="p-6 max-w-2xl">
      <h2 className="text-lg font-semibold text-text-main mb-4">模型配置</h2>
      <div className="space-y-3 mb-6">
        {configs.map((cfg) => (
          <div
            key={cfg.id}
            className="flex items-center justify-between p-3 border border-border rounded-lg bg-bg-panel"
          >
            <div>
              <div className="font-medium text-text-main">{cfg.name}</div>
              <div className="text-xs text-text-muted">
                {cfg.baseUrl} · {cfg.modelName}
                {cfg.isDefault && (
                  <span className="ml-2 text-primary">默认</span>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleTest(cfg.id)}
                className="px-3 py-1 text-sm border border-border rounded hover:bg-bg-base cursor-pointer"
              >
                测试
              </button>
              <button
                onClick={() => setEditing(cfg)}
                className="px-3 py-1 text-sm border border-border rounded hover:bg-bg-base cursor-pointer"
              >
                编辑
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing ? (
        <div className="border border-border rounded-lg p-4 bg-bg-panel space-y-3">
          <h3 className="font-medium text-text-main">
            {editing.id ? "编辑配置" : "新增配置"}
          </h3>
          <input
            placeholder="配置名称"
            value={editing.name || ""}
            onChange={(e) =>
              setEditing({ ...editing, name: e.target.value })
            }
            className="w-full px-3 py-2 border border-border rounded text-sm"
          />
          <input
            placeholder="Base URL"
            value={editing.baseUrl || ""}
            onChange={(e) =>
              setEditing({ ...editing, baseUrl: e.target.value })
            }
            className="w-full px-3 py-2 border border-border rounded text-sm"
          />
          <input
            placeholder="Model Name"
            value={editing.modelName || ""}
            onChange={(e) =>
              setEditing({ ...editing, modelName: e.target.value })
            }
            className="w-full px-3 py-2 border border-border rounded text-sm"
          />
          <input
            placeholder="API Key"
            type="password"
            onChange={(e) =>
              setEditing({ ...editing, apiKeyRef: e.target.value })
            }
            className="w-full px-3 py-2 border border-border rounded text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-primary text-white rounded hover:bg-primary-dark cursor-pointer"
            >
              保存
            </button>
            <button
              onClick={() => setEditing(null)}
              className="px-4 py-2 border border-border rounded hover:bg-bg-base cursor-pointer"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() =>
            setEditing({ name: "", baseUrl: "", modelName: "" })
          }
          className="px-4 py-2 border border-dashed border-border rounded-lg text-text-muted hover:text-text-main hover:border-primary cursor-pointer"
        >
          + 添加模型配置
        </button>
      )}
    </div>
  );
}
