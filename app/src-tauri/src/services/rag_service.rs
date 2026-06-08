use crate::db::AppDb;
use anyhow::Result;
use serde_json::Value;

pub struct RagService {
    db: AppDb,
}

impl RagService {
    pub fn new(db: AppDb) -> Self {
        Self { db }
    }

    pub async fn semantic_search(&self, novel_id: &str, query: &str) -> Result<Value> {
        // TODO: query LanceDB
        Ok(serde_json::json!({"results": []}))
    }
}
