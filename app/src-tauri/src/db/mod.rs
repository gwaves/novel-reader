use crate::models::*;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

pub struct AppDb {
    conn: Mutex<Connection>,
}

impl AppDb {
    pub fn new(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS novels (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                author TEXT,
                source_path TEXT NOT NULL,
                format TEXT CHECK(format IN ('txt','epub','pdf')),
                total_chars INTEGER DEFAULT 0,
                total_chapters INTEGER DEFAULT 0,
                status TEXT CHECK(status IN ('imported','parsing','embedding','extracting','completed','error')),
                progress_json TEXT,
                created_at INTEGER,
                updated_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS chapters (
                novel_id TEXT NOT NULL,
                idx INTEGER NOT NULL,
                title TEXT NOT NULL,
                level INTEGER DEFAULT 1,
                content_ref TEXT,
                char_count INTEGER DEFAULT 0,
                start_paragraph_idx INTEGER,
                end_paragraph_idx INTEGER,
                PRIMARY KEY (novel_id, idx),
                FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chat_sessions (
                id TEXT PRIMARY KEY,
                novel_id TEXT NOT NULL,
                title TEXT,
                model_config_id TEXT,
                created_at INTEGER,
                updated_at INTEGER,
                FOREIGN KEY (novel_id) REFERENCES novels(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT CHECK(role IN ('user','assistant','system')),
                content TEXT NOT NULL,
                citations_json TEXT,
                model TEXT,
                timestamp INTEGER,
                FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS model_configs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                base_url TEXT NOT NULL,
                model_name TEXT NOT NULL,
                api_key_ref TEXT,
                is_default INTEGER DEFAULT 0,
                created_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_chapters_novel ON chapters(novel_id);
            CREATE INDEX IF NOT EXISTS idx_chat_sessions_novel ON chat_sessions(novel_id);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
            "#,
        )?;

        // 修复旧数据中 is_default 存成 "true"/"false" 文本的问题
        let _ = conn.execute(
            "UPDATE model_configs SET is_default = 1 WHERE is_default = 'true' OR is_default = '1'",
            [],
        );
        let _ = conn.execute(
            "UPDATE model_configs SET is_default = 0 WHERE is_default = 'false' OR is_default = '0' OR is_default IS NULL",
            [],
        );

        Ok(())
    }

    pub fn list_novels(&self) -> Result<Vec<Novel>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, author, source_path, format, total_chars, total_chapters, status, progress_json, created_at, updated_at FROM novels ORDER BY created_at DESC"
        )?;
        let novels = stmt.query_map([], |row| {
            Ok(Novel {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                source_path: row.get(3)?,
                format: row.get(4)?,
                total_chars: row.get(5)?,
                total_chapters: row.get(6)?,
                status: row.get(7)?,
                progress_json: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        let result: Result<Vec<_>, _> = novels.collect();
        Ok(result?)
    }

    pub fn insert_novel(&self, novel: &Novel) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let author = novel.author.clone().unwrap_or_default();
        let progress = novel.progress_json.clone().unwrap_or_default();
        conn.execute(
            "INSERT INTO novels (id, title, author, source_path, format, total_chars, total_chapters, status, progress_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            [
                &novel.id,
                &novel.title,
                &author,
                &novel.source_path,
                &novel.format,
                &novel.total_chars.to_string(),
                &novel.total_chapters.to_string(),
                &novel.status,
                &progress,
                &novel.created_at.to_string(),
                &novel.updated_at.to_string(),
            ],
        )?;
        Ok(())
    }

    pub fn get_novel(&self, novel_id: &str) -> Result<Option<Novel>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, author, source_path, format, total_chars, total_chapters, status, progress_json, created_at, updated_at FROM novels WHERE id = ?1"
        )?;
        let novel = stmt.query_row([novel_id], |row| {
            Ok(Novel {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                source_path: row.get(3)?,
                format: row.get(4)?,
                total_chars: row.get(5)?,
                total_chapters: row.get(6)?,
                status: row.get(7)?,
                progress_json: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        }).optional()?;
        Ok(novel)
    }

    pub fn update_novel_status(&self, novel_id: &str, status: &str, progress_json: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE novels SET status = ?1, progress_json = ?2, updated_at = ?3 WHERE id = ?4",
            [status, progress_json.unwrap_or(""), &chrono::Utc::now().timestamp_millis().to_string(), novel_id],
        )?;
        Ok(())
    }

    pub fn delete_novel(&self, novel_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM novels WHERE id = ?1", [novel_id])?;
        Ok(())
    }

    pub fn insert_chapters(&self, chapters: &[Chapter]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        for ch in chapters {
            conn.execute(
                "INSERT INTO chapters (novel_id, idx, title, level, content_ref, char_count, start_paragraph_idx, end_paragraph_idx) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                [
                    &ch.novel_id,
                    &ch.idx.to_string(),
                    &ch.title,
                    &ch.level.to_string(),
                    ch.content_ref.as_deref().unwrap_or(""),
                    &ch.char_count.to_string(),
                    &ch.start_paragraph_idx.map(|v| v.to_string()).unwrap_or_default(),
                    &ch.end_paragraph_idx.map(|v| v.to_string()).unwrap_or_default(),
                ],
            )?;
        }
        Ok(())
    }

    pub fn list_chapters(&self, novel_id: &str) -> Result<Vec<Chapter>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT novel_id, idx, title, level, content_ref, char_count, start_paragraph_idx, end_paragraph_idx FROM chapters WHERE novel_id = ?1 ORDER BY idx"
        )?;
        let chapters = stmt.query_map([novel_id], |row| {
            Ok(Chapter {
                novel_id: row.get(0)?,
                idx: row.get(1)?,
                title: row.get(2)?,
                level: row.get(3)?,
                content_ref: row.get(4)?,
                char_count: row.get(5)?,
                start_paragraph_idx: row.get(6)?,
                end_paragraph_idx: row.get(7)?,
            })
        })?;
        let result: Result<Vec<_>, _> = chapters.collect();
        Ok(result?)
    }

    pub fn insert_model_config(&self, config: &ModelConfig) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO model_configs (id, name, base_url, model_name, api_key_ref, is_default, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            [
                &config.id,
                &config.name,
                &config.base_url,
                &config.model_name,
                config.api_key_ref.as_deref().unwrap_or(""),
                &(if config.is_default { 1 } else { 0 }).to_string(),
                &config.created_at.to_string(),
            ],
        )?;
        Ok(())
    }

    pub fn list_model_configs(&self) -> Result<Vec<ModelConfig>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, base_url, model_name, api_key_ref, is_default, created_at FROM model_configs ORDER BY created_at DESC"
        )?;
        let configs = stmt.query_map([], |row| {
            Ok(ModelConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                model_name: row.get(3)?,
                api_key_ref: row.get(4)?,
                is_default: row.get::<_, i32>(5)? != 0,
                created_at: row.get(6)?,
            })
        })?;
        let result: Result<Vec<_>, _> = configs.collect();
        Ok(result?)
    }

    pub fn get_model_config(&self, config_id: &str) -> Result<Option<ModelConfig>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, base_url, model_name, api_key_ref, is_default, created_at FROM model_configs WHERE id = ?1"
        )?;
        let config = stmt.query_row([config_id], |row| {
            Ok(ModelConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                model_name: row.get(3)?,
                api_key_ref: row.get(4)?,
                is_default: row.get::<_, i32>(5)? != 0,
                created_at: row.get(6)?,
            })
        }).optional()?;
        Ok(config)
    }

    pub fn delete_model_config(&self, config_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM model_configs WHERE id = ?1", [config_id])?;
        Ok(())
    }

    pub fn insert_chat_session(&self, session: &ChatSession) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO chat_sessions (id, novel_id, title, model_config_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            [
                &session.id,
                &session.novel_id,
                session.title.as_deref().unwrap_or(""),
                session.model_config_id.as_deref().unwrap_or(""),
                &session.created_at.to_string(),
                &session.updated_at.to_string(),
            ],
        )?;
        Ok(())
    }

    pub fn list_chat_sessions(&self, novel_id: &str) -> Result<Vec<ChatSession>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, novel_id, title, model_config_id, created_at, updated_at FROM chat_sessions WHERE novel_id = ?1 ORDER BY updated_at DESC"
        )?;
        let sessions = stmt.query_map([novel_id], |row| {
            Ok(ChatSession {
                id: row.get(0)?,
                novel_id: row.get(1)?,
                title: row.get(2)?,
                model_config_id: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        let result: Result<Vec<_>, _> = sessions.collect();
        Ok(result?)
    }

    pub fn insert_chat_message(&self, msg: &ChatMessage) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, citations_json, model, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            [
                &msg.id,
                &msg.session_id,
                &msg.role,
                &msg.content,
                msg.citations_json.as_deref().unwrap_or(""),
                msg.model.as_deref().unwrap_or(""),
                &msg.timestamp.to_string(),
            ],
        )?;
        Ok(())
    }

    pub fn get_session_history(&self, session_id: &str) -> Result<Vec<ChatMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, citations_json, model, timestamp FROM chat_messages WHERE session_id = ?1 ORDER BY timestamp"
        )?;
        let messages = stmt.query_map([session_id], |row| {
            Ok(ChatMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                citations_json: row.get(4)?,
                model: row.get(5)?,
                timestamp: row.get(6)?,
            })
        })?;
        let result: Result<Vec<_>, _> = messages.collect();
        Ok(result?)
    }

    pub fn delete_chat_session(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM chat_sessions WHERE id = ?1", [session_id])?;
        Ok(())
    }

    // ==================== Graph Schema (SQLite fallback for KuzuDB) ====================

    pub fn init_graph_schema(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY,
                novel_id TEXT NOT NULL,
                type TEXT CHECK(type IN ('person','faction','item','skill','location')),
                name TEXT NOT NULL,
                aliases_json TEXT,
                description TEXT,
                first_appearance_chapter INTEGER,
                metadata_json TEXT,
                source TEXT
            );

            CREATE TABLE IF NOT EXISTS relations (
                id TEXT PRIMARY KEY,
                novel_id TEXT NOT NULL,
                from_entity TEXT NOT NULL,
                to_entity TEXT NOT NULL,
                type TEXT,
                description TEXT,
                chapter_index INTEGER,
                source TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_entities_novel ON entities(novel_id);
            CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
            CREATE INDEX IF NOT EXISTS idx_relations_novel ON relations(novel_id);
            CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
            CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity);
            "#,
        )?;
        Ok(())
    }

    pub fn insert_entities(&self, entities: &[serde_json::Value]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        for e in entities {
            let id = e.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let novel_id = e.get("novelId").and_then(|v| v.as_str()).unwrap_or("");
            let typ = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let name = e.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let aliases = serde_json::to_string(e.get("aliases").unwrap_or(&serde_json::Value::Null)).unwrap_or_default();
            let description = e.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let first_ch = e.get("firstAppearanceChapter").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let metadata = serde_json::to_string(e.get("metadata").unwrap_or(&serde_json::Value::Null)).unwrap_or_default();
            let source = e.get("source").and_then(|v| v.as_str()).unwrap_or("auto");

            conn.execute(
                "INSERT OR REPLACE INTO entities (id, novel_id, type, name, aliases_json, description, first_appearance_chapter, metadata_json, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                [id, novel_id, typ, name, &aliases, description, &first_ch.to_string(), &metadata, source],
            )?;
        }
        Ok(())
    }

    pub fn insert_relations(&self, relations: &[serde_json::Value]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        for r in relations {
            let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let novel_id = r.get("novelId").and_then(|v| v.as_str()).unwrap_or("");
            let from_e = r.get("from").and_then(|v| v.as_str()).unwrap_or("");
            let to_e = r.get("to").and_then(|v| v.as_str()).unwrap_or("");
            let typ = r.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let description = r.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let chapter_idx = r.get("chapterIndex").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let source = r.get("source").and_then(|v| v.as_str()).unwrap_or("auto");

            conn.execute(
                "INSERT OR REPLACE INTO relations (id, novel_id, from_entity, to_entity, type, description, chapter_index, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                [id, novel_id, from_e, to_e, typ, description, &chapter_idx.to_string(), source],
            )?;
        }
        Ok(())
    }

    pub fn get_entities(&self, novel_id: &str, types: Option<&[String]>) -> Result<Vec<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<serde_json::Value> {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "novelId": row.get::<_, String>(1)?,
                "type": row.get::<_, String>(2)?,
                "name": row.get::<_, String>(3)?,
                "aliases": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(4).unwrap_or_default()).unwrap_or(serde_json::Value::Array(vec![])),
                "description": row.get::<_, String>(5).unwrap_or_default(),
                "firstAppearanceChapter": row.get::<_, Option<i32>>(6)?,
                "metadata": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(7).unwrap_or_default()).unwrap_or(serde_json::Value::Object(Default::default())),
                "source": row.get::<_, String>(8).unwrap_or_default(),
            }))
        };

        if let Some(t) = types {
            let placeholders: Vec<String> = t.iter().map(|_| "?".to_string()).collect();
            let sql = format!(
                "SELECT id, novel_id, type, name, aliases_json, description, first_appearance_chapter, metadata_json, source FROM entities WHERE novel_id = ? AND type IN ({})",
                placeholders.join(",")
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut params: Vec<&dyn rusqlite::ToSql> = vec![&novel_id];
            for typ in t {
                params.push(typ);
            }
            let rows = stmt.query_map(params.as_slice(), map_row)?;
            let result: Result<Vec<_>, _> = rows.collect();
            Ok(result?)
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, novel_id, type, name, aliases_json, description, first_appearance_chapter, metadata_json, source FROM entities WHERE novel_id = ?1"
            )?;
            let rows = stmt.query_map([novel_id], map_row)?;
            let result: Result<Vec<_>, _> = rows.collect();
            Ok(result?)
        }
    }

    pub fn get_relations(&self, novel_id: &str, from_id: Option<&str>, to_id: Option<&str>) -> Result<Vec<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<serde_json::Value> {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "novelId": row.get::<_, String>(1)?,
                "from": row.get::<_, String>(2)?,
                "to": row.get::<_, String>(3)?,
                "type": row.get::<_, String>(4)?,
                "description": row.get::<_, String>(5).unwrap_or_default(),
                "chapterIndex": row.get::<_, Option<i32>>(6)?,
                "source": row.get::<_, String>(7).unwrap_or_default(),
            }))
        };

        let mut sql = "SELECT id, novel_id, from_entity, to_entity, type, description, chapter_index, source FROM relations WHERE novel_id = ?1".to_string();
        let mut param_refs: Vec<&str> = vec![novel_id];

        if let Some(from) = from_id {
            sql.push_str(" AND from_entity = ?2");
            param_refs.push(from);
        }
        if let Some(to) = to_id {
            sql.push_str(" AND to_entity = ?3");
            param_refs.push(to);
        }

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(param_refs.iter()), map_row)?;
        let result: Result<Vec<_>, _> = rows.collect();
        Ok(result?)
    }

    pub fn search_entities(&self, novel_id: &str, keyword: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("%{}%", keyword);
        let mut stmt = conn.prepare(
            "SELECT id, novel_id, type, name, aliases_json, description, first_appearance_chapter, metadata_json, source FROM entities WHERE novel_id = ?1 AND (name LIKE ?2 OR aliases_json LIKE ?2 OR description LIKE ?2)"
        )?;
        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<serde_json::Value> {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "novelId": row.get::<_, String>(1)?,
                "type": row.get::<_, String>(2)?,
                "name": row.get::<_, String>(3)?,
                "aliases": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(4).unwrap_or_default()).unwrap_or(serde_json::Value::Array(vec![])),
                "description": row.get::<_, String>(5).unwrap_or_default(),
                "firstAppearanceChapter": row.get::<_, Option<i32>>(6)?,
                "metadata": serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(7).unwrap_or_default()).unwrap_or(serde_json::Value::Object(Default::default())),
                "source": row.get::<_, String>(8).unwrap_or_default(),
            }))
        };
        let rows = stmt.query_map([novel_id, &pattern], map_row)?;
        let result: Result<Vec<_>, _> = rows.collect();
        Ok(result?)
    }

    pub fn delete_entities_by_novel(&self, novel_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM entities WHERE novel_id = ?1", [novel_id])?;
        conn.execute("DELETE FROM relations WHERE novel_id = ?1", [novel_id])?;
        Ok(())
    }
}
