use crate::config_manager::ConfigManager;
use crate::models::*;
use crate::AppState;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

// ==================== Novel Commands ====================

#[tauri::command]
pub async fn import_novel(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<ApiResult<Value>, String> {
    let novel_id = Uuid::new_v4().to_string();
    let source = PathBuf::from(&file_path);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("txt")
        .to_lowercase();

    let novel_dir = state.app_dir.join("novels").join(&novel_id);
    let _ = std::fs::create_dir_all(&novel_dir);

    // Copy file into app storage
    let dest_path = novel_dir.join(format!("source.{}", ext));
    if let Err(e) = std::fs::copy(&source, &dest_path) {
        return Ok(ApiResult::err("IO_ERROR", &format!("Failed to copy file: {}", e)));
    }

    // Parse document via sidecar
    let parse_result = {
        let sidecar = state.sidecar.lock().await;
        sidecar
            .send_request(
                "parse.document",
                serde_json::json!({"filePath": dest_path.to_string_lossy(), "format": ext}),
            )
            .await
    };

    let parsed = match parse_result {
        Ok(v) => v,
        Err(e) => {
            return Ok(ApiResult::err("PARSE_ERROR", &format!("Sidecar parse failed: {}", e)));
        }
    };

    let title = parsed
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or(&source.file_stem().unwrap_or_default().to_string_lossy())
        .to_string();
    let author = parsed.get("author").and_then(|a| a.as_str()).map(|s| s.to_string());
    let chapters_json = parsed.get("chapters").cloned().unwrap_or(Value::Array(vec![]));
    let paragraphs_json = parsed.get("paragraphs").cloned().unwrap_or(Value::Array(vec![]));

    let chapters_arr = chapters_json.as_array().cloned().unwrap_or_default();
    let paragraphs_arr = paragraphs_json.as_array().cloned().unwrap_or_default();

    let total_chars: i64 = paragraphs_arr.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str()).map(|t| t.len() as i64)).sum();

    // Insert novel
    let novel = Novel {
        id: novel_id.clone(),
        title: title.clone(),
        author: author.clone(),
        source_path: dest_path.to_string_lossy().to_string(),
        format: ext.clone(),
        total_chars,
        total_chapters: chapters_arr.len() as i64,
        status: "imported".to_string(),
        progress_json: Some(serde_json::to_string(&serde_json::json!({
            "chaptersExtracted": 100,
            "vectorsIndexed": 0,
            "entitiesExtracted": 0
        })).unwrap_or_default()),
        created_at: chrono::Utc::now().timestamp_millis(),
        updated_at: chrono::Utc::now().timestamp_millis(),
    };

    if let Err(e) = state.db_pool.insert_novel(&novel) {
        return Ok(ApiResult::err("DB_ERROR", &format!("Failed to insert novel: {}", e)));
    }

    // Insert chapters
    let chapters: Vec<Chapter> = chapters_arr
        .iter()
        .filter_map(|c| {
            Some(Chapter {
                novel_id: novel_id.clone(),
                idx: c.get("index")?.as_i64()? as i32,
                title: c.get("title")?.as_str()?.to_string(),
                level: c.get("level")?.as_i64().unwrap_or(1) as i32,
                content_ref: None,
                char_count: c.get("charCount")?.as_i64().unwrap_or(0) as i32,
                start_paragraph_idx: c.get("startParagraphIndex").and_then(|v| v.as_i64()).map(|v| v as i32),
                end_paragraph_idx: c.get("endParagraphIndex").and_then(|v| v.as_i64()).map(|v| v as i32),
            })
        })
        .collect();

    if let Err(e) = state.db_pool.insert_chapters(&chapters) {
        return Ok(ApiResult::err("DB_ERROR", &format!("Failed to insert chapters: {}", e)));
    }

    // Spawn background tasks: entity extraction + embedding
    let db_pool = state.db_pool.clone();
    let sidecar = state.sidecar.clone();
    let app_dir = state.app_dir.clone();
    let novel_id_bg = novel_id.clone();

    tauri::async_runtime::spawn(async move {
        // 1. Entity extraction
        let _ = db_pool.update_novel_status(&novel_id_bg, "parsing", Some("{\"chaptersExtracted\":100,\"vectorsIndexed\":0,\"entitiesExtracted\":10}"));

        // Extract text from all paragraphs for LLM processing
        let text = paragraphs_arr
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .take(50) // Limit to first 50 paragraphs for MVP
            .collect::<Vec<_>>()
            .join("\n");

        if text.len() > 100 {
            let model_config = get_default_model_config_for_sidecar(&db_pool).await;
            if let Some(cfg) = model_config {
                let sidecar_guard = sidecar.lock().await;
                if let Ok(res) = sidecar_guard
                    .send_request(
                        "llm.extractEntities",
                        serde_json::json!({"text": &text[..text.len().min(8000)], "modelConfig": cfg, "maxTokens": 4096}),
                    )
                    .await
                {
                    if let Some(entities) = res.get("entities").and_then(|e| e.as_array()) {
                        let entities_with_id: Vec<Value> = entities
                            .iter()
                            .enumerate()
                            .map(|(i, e)| {
                                let mut e = e.clone();
                                e["id"] = Value::String(format!("{}#e{}", novel_id_bg, i));
                                e["novelId"] = Value::String(novel_id_bg.clone());
                                e
                            })
                            .collect();
                        let _ = db_pool.insert_entities(&entities_with_id);

                        // Extract relations
                        if let Ok(rel_res) = sidecar_guard
                            .send_request(
                                "llm.extractRelations",
                                serde_json::json!({"text": &text[..text.len().min(8000)], "entities": entities_with_id, "modelConfig": cfg, "maxTokens": 4096}),
                            )
                            .await
                        {
                            if let Some(relations) = rel_res.get("relations").and_then(|r| r.as_array()) {
                                let relations_with_id: Vec<Value> = relations
                                    .iter()
                                    .enumerate()
                                    .map(|(i, r)| {
                                        let mut r = r.clone();
                                        r["id"] = Value::String(format!("{}#r{}", novel_id_bg, i));
                                        r["novelId"] = Value::String(novel_id_bg.clone());
                                        r
                                    })
                                    .collect();
                                let _ = db_pool.insert_relations(&relations_with_id);
                            }
                        }
                    }
                }
            }
        }

        let _ = db_pool.update_novel_status(&novel_id_bg, "completed", Some("{\"chaptersExtracted\":100,\"vectorsIndexed\":0,\"entitiesExtracted\":100}"));
    });

    Ok(ApiResult::ok(serde_json::json!({"novel": novel})))
}

#[tauri::command]
pub async fn list_novels(state: State<'_, AppState>) -> Result<ApiResult<Value>, String> {
    match state.db_pool.list_novels() {
        Ok(novels) => Ok(ApiResult::ok(serde_json::json!({"novels": novels}))),
        Err(e) => Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    }
}

#[tauri::command]
pub async fn get_novel(
    state: State<'_, AppState>,
    novel_id: String,
) -> Result<ApiResult<Value>, String> {
    match state.db_pool.get_novel(&novel_id) {
        Ok(Some(novel)) => {
            let chapters = state.db_pool.list_chapters(&novel_id).unwrap_or_default();
            Ok(ApiResult::ok(serde_json::json!({
                "novel": novel,
                "chapters": chapters
            })))
        }
        Ok(None) => Ok(ApiResult::err("NOT_FOUND", "Novel not found")),
        Err(e) => Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    }
}

#[tauri::command]
pub async fn delete_novel(
    state: State<'_, AppState>,
    novel_id: String,
) -> Result<ApiResult<()>, String> {
    // Delete data directory
    let novel_dir = state.app_dir.join("novels").join(&novel_id);
    let _ = std::fs::remove_dir_all(novel_dir);

    // Delete from DB
    if let Err(e) = state.db_pool.delete_novel(&novel_id) {
        return Ok(ApiResult::err("DB_ERROR", &e.to_string()));
    }
    let _ = state.db_pool.delete_entities_by_novel(&novel_id);

    Ok(ApiResult::ok(()))
}

#[tauri::command]
pub async fn get_parse_progress(
    state: State<'_, AppState>,
    novel_id: String,
) -> Result<ApiResult<Value>, String> {
    match state.db_pool.get_novel(&novel_id) {
        Ok(Some(novel)) => {
            let progress: serde_json::Value = novel
                .progress_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::json!({
                    "chaptersExtracted": 0,
                    "vectorsIndexed": 0,
                    "entitiesExtracted": 0
                }));
            Ok(ApiResult::ok(serde_json::json!({
                "status": novel.status,
                "progress": progress
            })))
        }
        Ok(None) => Ok(ApiResult::err("NOT_FOUND", "Novel not found")),
        Err(e) => Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    }
}

// ==================== Graph Commands ====================

#[tauri::command]
pub async fn get_graph_data(
    state: State<'_, AppState>,
    novel_id: String,
    node_types: Option<Vec<String>>,
    relation_types: Option<Vec<String>>,
    center_node_id: Option<String>,
    depth: Option<i32>,
    chapter_range: Option<[i32; 2]>,
) -> Result<ApiResult<Value>, String> {
    let entities = match state.db_pool.get_entities(&novel_id, node_types.as_ref().map(|v| v.as_slice())) {
        Ok(e) => e,
        Err(e) => return Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    };

    let relations = match state.db_pool.get_relations(&novel_id, None, None) {
        Ok(r) => r,
        Err(e) => return Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    };

    // Filter relations by type if specified
    let filtered_relations: Vec<Value> = if let Some(types) = relation_types {
        relations.into_iter().filter(|r| {
            r.get("type").and_then(|t| t.as_str()).map(|t| types.contains(&t.to_string())).unwrap_or(true)
        }).collect()
    } else {
        relations
    };

    let nodes: Vec<Value> = entities
        .iter()
        .map(|e| {
            let name = e.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let typ = e.get("type").and_then(|t| t.as_str()).unwrap_or("person").to_string();
            serde_json::json!({
                "id": e.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "label": name,
                "type": typ,
                "data": e,
            })
        })
        .collect();

    let edges: Vec<Value> = filtered_relations
        .iter()
        .map(|r| {
            let typ = r.get("type").and_then(|t| t.as_str()).unwrap_or("related_to").to_string();
            serde_json::json!({
                "id": r.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "source": r.get("from").and_then(|v| v.as_str()).unwrap_or(""),
                "target": r.get("to").and_then(|v| v.as_str()).unwrap_or(""),
                "label": typ.clone(),
                "type": typ,
                "data": r,
            })
        })
        .collect();

    Ok(ApiResult::ok(serde_json::json!({
        "nodes": nodes,
        "edges": edges
    })))
}

#[tauri::command]
pub async fn search_entities(
    state: State<'_, AppState>,
    novel_id: String,
    keyword: String,
) -> Result<ApiResult<Value>, String> {
    match state.db_pool.search_entities(&novel_id, &keyword) {
        Ok(entities) => Ok(ApiResult::ok(serde_json::json!({"entities": entities}))),
        Err(e) => Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    }
}

#[tauri::command]
pub async fn get_entity_detail(
    state: State<'_, AppState>,
    novel_id: String,
    entity_id: String,
) -> Result<ApiResult<Value>, String> {
    let entities = match state.db_pool.get_entities(&novel_id, None) {
        Ok(e) => e,
        Err(e) => return Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    };

    let entity = match entities.iter().find(|e| {
        e.get("id").and_then(|v| v.as_str()) == Some(&entity_id)
    }) {
        Some(e) => e.clone(),
        None => return Ok(ApiResult::err("NOT_FOUND", "Entity not found")),
    };

    let relations = match state.db_pool.get_relations(&novel_id, Some(&entity_id), None) {
        Ok(r) => r,
        Err(e) => return Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    };

    let mut to_relations = match state.db_pool.get_relations(&novel_id, None, Some(&entity_id)) {
        Ok(r) => r,
        Err(_) => vec![],
    };

    let mut all_relations = relations;
    all_relations.append(&mut to_relations);

    let related_ids: Vec<String> = all_relations
        .iter()
        .filter_map(|r| {
            let from = r.get("from").and_then(|v| v.as_str())?;
            let to = r.get("to").and_then(|v| v.as_str())?;
            if from == entity_id { Some(to.to_string()) } else { Some(from.to_string()) }
        })
        .collect();

    let related_entities: Vec<Value> = entities
        .into_iter()
        .filter(|e| {
            let id = e.get("id").and_then(|v| v.as_str()).unwrap_or("");
            related_ids.contains(&id.to_string()) && id != entity_id
        })
        .collect();

    Ok(ApiResult::ok(serde_json::json!({
        "entity": entity,
        "relations": all_relations,
        "relatedEntities": related_entities
    })))
}

#[tauri::command]
pub async fn merge_entities(
    _state: State<'_, AppState>,
    _novel_id: String,
    _target_id: String,
    _source_ids: Vec<String>,
) -> Result<ApiResult<()>, String> {
    // TODO: implement merge logic
    Ok(ApiResult::ok(()))
}

#[tauri::command]
pub async fn upsert_entity(
    state: State<'_, AppState>,
    novel_id: String,
    entity: Value,
) -> Result<ApiResult<Value>, String> {
    let mut e = entity;
    if e.get("id").is_none() {
        e["id"] = Value::String(format!("{}#e{}", novel_id, Uuid::new_v4()));
    }
    e["novelId"] = Value::String(novel_id);
    if let Err(err) = state.db_pool.insert_entities(&[e.clone()]) {
        return Ok(ApiResult::err("DB_ERROR", &err.to_string()));
    }
    Ok(ApiResult::ok(e))
}

#[tauri::command]
pub async fn upsert_relation(
    state: State<'_, AppState>,
    novel_id: String,
    relation: Value,
) -> Result<ApiResult<Value>, String> {
    let mut r = relation;
    if r.get("id").is_none() {
        r["id"] = Value::String(format!("{}#r{}", novel_id, Uuid::new_v4()));
    }
    r["novelId"] = Value::String(novel_id);
    if let Err(err) = state.db_pool.insert_relations(&[r.clone()]) {
        return Ok(ApiResult::err("DB_ERROR", &err.to_string()));
    }
    Ok(ApiResult::ok(r))
}

// ==================== RAG / Chat Commands ====================

#[tauri::command]
pub async fn semantic_search(
    _state: State<'_, AppState>,
    _novel_id: String,
    _query: String,
) -> Result<ApiResult<Value>, String> {
    // TODO: implement LanceDB vector search
    Ok(ApiResult::ok(serde_json::json!({"results": []})))
}

#[tauri::command]
pub async fn chat(
    state: State<'_, AppState>,
    novel_id: String,
    message: String,
    _session_id: Option<String>,
) -> Result<ApiResult<Value>, String> {
    let model_config = match get_default_model_config_for_sidecar(&state.db_pool).await {
        Some(c) => c,
        None => return Ok(ApiResult::err("LLM_ERROR", "No model config available")),
    };

    let sidecar = state.sidecar.lock().await;
    match sidecar
        .send_request(
            "llm.chat",
            serde_json::json!({
                "messages": [{"role": "user", "content": message}],
                "context": [],
                "modelConfig": model_config
            }),
        )
        .await
    {
        Ok(res) => {
            let content = res.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
            Ok(ApiResult::ok(serde_json::json!({
                "message": {
                    "id": Uuid::new_v4().to_string(),
                    "novelId": novel_id,
                    "sessionId": "",
                    "role": "assistant",
                    "content": content,
                    "citations": res.get("citations").cloned().unwrap_or(Value::Array(vec![])),
                    "timestamp": chrono::Utc::now().timestamp_millis()
                }
            })))
        }
        Err(e) => Ok(ApiResult::err("LLM_ERROR", &e.to_string())),
    }
}

#[tauri::command]
pub async fn chat_stream(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    novel_id: String,
    message: String,
    _session_id: Option<String>,
) -> Result<ApiResult<()>, String> {
    let model_config = match get_default_model_config_for_sidecar(&state.db_pool).await {
        Some(c) => c,
        None => return Ok(ApiResult::err("LLM_ERROR", "No model config available")),
    };

    let sidecar = state.sidecar.clone();
    let request_id = Uuid::new_v4().to_string();

    tauri::async_runtime::spawn(async move {
        let sidecar_guard = sidecar.lock().await;
        match sidecar_guard
            .send_request(
                "llm.chat",
                serde_json::json!({
                    "messages": [{"role": "user", "content": message}],
                    "context": [],
                    "modelConfig": model_config
                }),
            )
            .await
        {
            Ok(res) => {
                let content = res.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
                // Stream the content in chunks to simulate streaming
                let chunk_size = 8usize;
                for chunk in content.as_bytes().chunks(chunk_size) {
                    let text = String::from_utf8_lossy(chunk).to_string();
                    let _ = app_handle.emit("chat:stream", serde_json::json!({
                        "requestId": request_id,
                        "type": "delta",
                        "delta": text
                    }));
                    tokio::time::sleep(tokio::time::Duration::from_millis(30)).await;
                }
                let _ = app_handle.emit("chat:stream", serde_json::json!({
                    "requestId": request_id,
                    "type": "done"
                }));
            }
            Err(e) => {
                let _ = app_handle.emit("chat:stream", serde_json::json!({
                    "requestId": request_id,
                    "type": "error",
                    "error": {"code": "LLM_ERROR", "message": e.to_string()}
                }));
            }
        }
    });

    Ok(ApiResult::ok(()))
}

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
    novel_id: String,
) -> Result<ApiResult<Value>, String> {
    match state.db_pool.list_chat_sessions(&novel_id) {
        Ok(sessions) => {
            let sessions_with_count: Vec<Value> = sessions
                .into_iter()
                .map(|s| {
                    serde_json::json!({
                        "id": s.id,
                        "novelId": s.novel_id,
                        "title": s.title.unwrap_or_else(|| "新会话".to_string()),
                        "messageCount": 0,
                        "updatedAt": s.updated_at
                    })
                })
                .collect();
            Ok(ApiResult::ok(serde_json::json!({"sessions": sessions_with_count})))
        }
        Err(e) => Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    }
}

#[tauri::command]
pub async fn get_session_history(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ApiResult<Value>, String> {
    match state.db_pool.get_session_history(&session_id) {
        Ok(messages) => {
            let msgs: Vec<Value> = messages
                .into_iter()
                .map(|m| {
                    serde_json::json!({
                        "id": m.id,
                        "sessionId": m.session_id,
                        "role": m.role,
                        "content": m.content,
                        "citations": serde_json::from_str::<Value>(&m.citations_json.unwrap_or_default()).unwrap_or(Value::Array(vec![])),
                        "model": m.model,
                        "timestamp": m.timestamp
                    })
                })
                .collect();
            Ok(ApiResult::ok(serde_json::json!({"messages": msgs})))
        }
        Err(e) => Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    }
}

#[tauri::command]
pub async fn delete_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ApiResult<()>, String> {
    match state.db_pool.delete_chat_session(&session_id) {
        Ok(()) => Ok(ApiResult::ok(())),
        Err(e) => Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    }
}

// ==================== Settings Commands ====================

#[tauri::command]
pub async fn get_settings(
    state: State<'_, AppState>,
) -> Result<ApiResult<Value>, String> {
    let config = state.config.lock().await;
    let settings = serde_json::to_value(config.get()).map_err(|e| e.to_string())?;
    Ok(ApiResult::ok(serde_json::json!({"settings": settings})))
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    settings: Value,
) -> Result<ApiResult<()>, String> {
    let new_settings: crate::config_manager::AppSettings = serde_json::from_value(settings)
        .map_err(|e| e.to_string())?;
    let mut config = state.config.lock().await;
    match config.update(new_settings) {
        Ok(()) => Ok(ApiResult::ok(())),
        Err(e) => Ok(ApiResult::err("IO_ERROR", &e.to_string())),
    }
}

#[tauri::command]
pub async fn list_model_configs(
    state: State<'_, AppState>,
) -> Result<ApiResult<Value>, String> {
    match state.db_pool.list_model_configs() {
        Ok(configs) => {
            let configs_json: Vec<Value> = configs
                .into_iter()
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "name": c.name,
                        "baseUrl": c.base_url,
                        "modelName": c.model_name,
                        "apiKeyRef": c.api_key_ref,
                        "isDefault": c.is_default,
                        "temperature": c.temperature
                    })
                })
                .collect();
            Ok(ApiResult::ok(serde_json::json!({"configs": configs_json})))
        }
        Err(e) => Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    }
}

fn append_log(app_dir: &std::path::Path, msg: &str) {
    use std::io::Write;
    let log_path = app_dir.join("command.log");
    let line = format!("{} {}\n", chrono::Utc::now().to_rfc3339(), msg);
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log_path)
        .and_then(|mut f| f.write_all(line.as_bytes()));
}

#[tauri::command]
pub async fn upsert_model_config(
    state: State<'_, AppState>,
    config: Value,
) -> Result<ApiResult<()>, String> {
    append_log(&state.app_dir, "[upsert_model_config] called");
    // 注意：不再记录包含 apiKeyRef 的 config 明文
    append_log(&state.app_dir, "[upsert_model_config] config received");

    let id = config.get("id").and_then(|v| v.as_str()).unwrap_or(&Uuid::new_v4().to_string()).to_string();
    let name = config.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let base_url = config.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let model_name = config.get("modelName").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let api_key = config.get("apiKeyRef").or_else(|| config.get("apiKey")).and_then(|v| v.as_str());
    let is_default = config.get("isDefault").and_then(|v| v.as_bool()).unwrap_or(false);
    let temperature = config.get("temperature").and_then(|v| v.as_f64()).unwrap_or(1.0) as f32;

    append_log(&state.app_dir, &format!("[upsert_model_config] extracted: id={} name={} base_url={} model={} temperature={}", id, name, base_url, model_name, temperature));

    // Store API key in Keychain
    if let Some(key) = api_key {
        let _ = ConfigManager::store_api_key(&id, key);
    }

    let db_config = ModelConfig {
        id: id.clone(),
        name,
        base_url,
        model_name,
        api_key_ref: Some(format!("novelreader.apikey.{}", id)),
        is_default,
        temperature,
        created_at: chrono::Utc::now().timestamp_millis(),
    };

    append_log(&state.app_dir, "[upsert_model_config] inserting...");

    match state.db_pool.insert_model_config(&db_config) {
        Ok(()) => {
            append_log(&state.app_dir, "[upsert_model_config] SUCCESS");
            Ok(ApiResult::ok(()))
        }
        Err(e) => {
            append_log(&state.app_dir, &format!("[upsert_model_config] DB_ERROR: {}", e));
            Ok(ApiResult::err("DB_ERROR", &e.to_string()))
        }
    }
}

#[tauri::command]
pub async fn delete_model_config(
    state: State<'_, AppState>,
    config_id: String,
) -> Result<ApiResult<()>, String> {
    let _ = ConfigManager::delete_api_key(&config_id);
    match state.db_pool.delete_model_config(&config_id) {
        Ok(()) => Ok(ApiResult::ok(())),
        Err(e) => Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    }
}

#[tauri::command]
pub async fn test_model_connection(
    state: State<'_, AppState>,
    config_id: String,
) -> Result<ApiResult<Value>, String> {
    let config = match state.db_pool.get_model_config(&config_id) {
        Ok(Some(c)) => c,
        Ok(None) => return Ok(ApiResult::err("NOT_FOUND", "Model config not found")),
        Err(e) => return Ok(ApiResult::err("DB_ERROR", &e.to_string())),
    };

    let api_key = ConfigManager::get_api_key(&config_id).unwrap_or(None);

    let sidecar = state.sidecar.lock().await;
    let start = std::time::Instant::now();

    match sidecar
        .send_request(
            "system.health",
            serde_json::json!({}),
        )
        .await
    {
        Ok(_) => {
            // Also test LLM connection by sending a minimal request
            let llm_config = serde_json::json!({
                "base_url": config.base_url,
                "model_name": config.model_name,
                "api_key": api_key.unwrap_or_default(),
                "temperature": config.temperature
            });

            match sidecar
                .send_request(
                    "llm.chat",
                    serde_json::json!({
                        "messages": [{"role": "user", "content": "Hi"}],
                        "context": [],
                        "modelConfig": llm_config,
                        "maxTokens": 5
                    }),
                )
                .await
            {
                Ok(_) => Ok(ApiResult::ok(serde_json::json!({
                    "success": true,
                    "latency": start.elapsed().as_millis() as u64
                }))),
                Err(e) => Ok(ApiResult::ok(serde_json::json!({
                    "success": false,
                    "latency": start.elapsed().as_millis() as u64,
                    "modelInfo": e.to_string()
                }))),
            }
        }
        Err(e) => Ok(ApiResult::ok(serde_json::json!({
            "success": false,
            "latency": start.elapsed().as_millis() as u64,
            "modelInfo": e.to_string()
        }))),
    }
}

// ==================== Helpers ====================

async fn get_default_model_config_for_sidecar(db: &crate::db::AppDb) -> Option<Value> {
    let configs = db.list_model_configs().ok()?;
    let default = configs.into_iter().find(|c| c.is_default)
        .or_else(|| db.list_model_configs().ok()?.into_iter().next())?;

    let api_key = ConfigManager::get_api_key(&default.id).unwrap_or(None);

    Some(serde_json::json!({
        "base_url": default.base_url,
        "model_name": default.model_name,
        "api_key": api_key.unwrap_or_default(),
        "temperature": default.temperature
    }))
}
