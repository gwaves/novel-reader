import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ApiResult, ModelConfig } from "../types";

/** 兼容的 UUID 生成 */
function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 持久化日志工具 */
const LOG_KEY = "novelreader_debug_logs";
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

export default function SettingsPanel() {
  const [configs, setConfigs] = useState<ModelConfig[]>([]);
  const [editing, setEditing] = useState<Partial<ModelConfig> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [debugMsg, setDebugMsg] = useState<string>("");
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

  // 检测组件挂载/卸载
  useEffect(() => {
    addLog("[SettingsPanel] MOUNTED");
    return () => {
      addLog("[SettingsPanel] UNMOUNTED");
    };
  }, []);


  const loadConfigs = async () => {
    addLog("[loadConfigs] start");
    try {
      const res = await invoke<ApiResult<{ configs: ModelConfig[] }>>(
        "list_model_configs"
      );
      addLog("[loadConfigs] res=" + JSON.stringify(res).slice(0, 200));
      if (res.success && res.data) {
        setConfigs(res.data.configs);
      }
    } catch (e: any) {
      addLog("[loadConfigs] ERROR: " + (e?.message || String(e)));
    }
  };

  useEffect(() => {
    loadConfigs();
  }, []);

  const handleSave = async () => {
    addLog("[handleSave] START");
    setSaveError(null);
    setDebugMsg("① 开始保存...");

    if (!editing?.name || !editing?.baseUrl || !editing?.modelName) {
      setSaveError("请填写所有必填字段");
      setDebugMsg("② 验证失败");
      addLog("[handleSave] validation failed");
      return;
    }

    setDebugMsg("② 验证通过");
    addLog("[handleSave] validation passed");

    try {
      // 第一步：测试已知正常的命令
      setDebugMsg("③ 测试 list_model_configs...");
      addLog("[handleSave] invoking list_model_configs...");
      const listRes = await invoke<ApiResult<{ configs: ModelConfig[] }>>(
        "list_model_configs"
      );
      addLog("[handleSave] list_model_configs returned: " + JSON.stringify(listRes).slice(0, 200));
      setDebugMsg("③ list 返回 OK");

      // 第二步：调用保存命令
      const payload = {
        id: editing.id || generateUUID(),
        name: editing.name,
        baseUrl: editing.baseUrl,
        modelName: editing.modelName,
        apiKeyRef: editing.apiKeyRef || "",
        isDefault: editing.isDefault ?? false,
        temperature: editing.temperature ?? 1.0,
      };
      setDebugMsg("④ 准备调用 upsert_model_config...");
      addLog("[handleSave] invoking upsert_model_config with payload: " + JSON.stringify(payload));

      const res = await invoke<ApiResult<unknown>>("upsert_model_config", {
        config: payload,
      });

      addLog("[handleSave] upsert_model_config returned: " + JSON.stringify(res).slice(0, 200));
      setDebugMsg("⑤ 后端返回 OK");

      if (res.success) {
        addLog("[handleSave] SUCCESS");
        loadConfigs();
        setDebugMsg("⑥ 保存成功！");
        setEditing(null);
      } else {
        addLog("[handleSave] FAILED: " + JSON.stringify(res.error));
        setSaveError(res.error?.message || "保存失败");
        setDebugMsg("⑥ 保存失败");
      }
    } catch (e: any) {
      addLog("[handleSave] EXCEPTION: " + (e?.message || String(e)));
      console.error("Save failed:", e);
      setSaveError(e?.message || "保存异常");
      setDebugMsg("❌ 异常: " + (e?.message || String(e)));
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
          : `连接失败: ${res.data ? JSON.stringify(res.data) : "未知错误"}`
      );
    } catch (e: any) {
      alert("测试失败: " + (e?.message || String(e)));
    }
  };

  const handleDelete = async (configId: string) => {
    if (!confirm("确定要删除这个模型配置吗？")) return;
    try {
      const res = await invoke<ApiResult<unknown>>("delete_model_config", {
        configId,
      });
      if (res.success) {
        loadConfigs();
      } else {
        alert(`删除失败: ${res.error?.message || "未知错误"}`);
      }
    } catch (e: any) {
      alert(`删除异常: ${e?.message || String(e)}`);
    }
  };

  return (
    <div className="p-6 max-w-2xl">
      <h2 className="text-lg font-semibold text-text-main mb-4">模型配置</h2>

      {/* 持久化日志显示区 */}
      {logs.length > 0 && (
        <div className="mb-4 p-2 bg-gray-900 text-green-400 text-xs rounded border border-gray-700 font-mono max-h-40 overflow-auto">
          <div className="flex justify-between items-center mb-1">
            <span className="font-bold text-gray-300">持久化日志</span>
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

      <div className="space-y-3 mb-6">
        {configs.map((cfg) => (
          <div
            key={cfg.id}
            className="flex items-center justify-between p-3 border border-border rounded-lg bg-bg-panel"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium text-text-main truncate">
                {cfg.name}
              </div>
              <div className="text-xs text-text-muted truncate">
                {cfg.baseUrl || "no url"} · {cfg.modelName || "no model"}
                {cfg.isDefault && (
                  <span className="ml-2 text-primary">默认</span>
                )}
              </div>
            </div>
            <div className="flex gap-2 ml-2 flex-shrink-0">
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
              <button
                onClick={() => handleDelete(cfg.id)}
                className="px-3 py-1 text-sm border border-red-200 rounded hover:bg-red-50 text-red-500 cursor-pointer"
              >
                删除
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

          {debugMsg && (
            <div className="p-2 bg-blue-50 text-blue-700 text-xs rounded border border-blue-200 font-mono">
              DEBUG: {debugMsg}
            </div>
          )}

          {saveError && (
            <div className="p-2 bg-red-50 text-red-600 text-sm rounded border border-red-200">
              {saveError}
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-sm text-text-muted">配置名称 *</label>
            <input
              placeholder="例如：OpenAI GPT-4"
              value={editing.name || ""}
              onChange={(e) =>
                setEditing({ ...editing, name: e.target.value })
              }
              className="w-full px-3 py-2 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm text-text-muted">
              Base URL *
            </label>
            <input
              placeholder="例如：https://api.openai.com/v1"
              value={editing.baseUrl || ""}
              onChange={(e) =>
                setEditing({ ...editing, baseUrl: e.target.value })
              }
              className="w-full px-3 py-2 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm text-text-muted">
              Model Name *
            </label>
            <input
              placeholder="例如：gpt-4"
              value={editing.modelName || ""}
              onChange={(e) =>
                setEditing({ ...editing, modelName: e.target.value })
              }
              className="w-full px-3 py-2 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm text-text-muted">
              Temperature（采样温度）
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              placeholder="1.0"
              value={editing.temperature ?? 1.0}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  temperature: e.target.value === "" ? 1.0 : parseFloat(e.target.value),
                })
              }
              className="w-full px-3 py-2 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <p className="text-xs text-text-muted">
              部分模型（如 kimi-k2.6）只支持 temperature=1.0
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-sm text-text-muted">API Key</label>
            <input
              placeholder="sk-..."
              type="password"
              value={editing.apiKeyRef || ""}
              onChange={(e) =>
                setEditing({ ...editing, apiKeyRef: e.target.value })
              }
              className="w-full px-3 py-2 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isDefault"
              checked={editing.isDefault || false}
              onChange={(e) =>
                setEditing({ ...editing, isDefault: e.target.checked })
              }
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
            />
            <label htmlFor="isDefault" className="text-sm text-text-muted">
              设为默认配置
            </label>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={() => handleSave()}
              className="px-4 py-2 bg-primary text-white rounded hover:bg-primary-dark cursor-pointer"
            >
              保存
            </button>
            <button
              onClick={() => {
                setEditing(null);
                setSaveError(null);
              }}
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
