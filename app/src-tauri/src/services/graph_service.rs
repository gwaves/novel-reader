use crate::db::AppDb;
use anyhow::Result;
use serde_json::Value;

pub struct GraphService {
    db: AppDb,
}

impl GraphService {
    pub fn new(db: AppDb) -> Self {
        Self { db }
    }

    pub async fn get_graph_data(
        &self,
        novel_id: &str,
        node_types: Option<Vec<String>>,
    ) -> Result<Value> {
        // TODO: query KuzuDB
        Ok(serde_json::json!({"nodes": [], "edges": []}))
    }

    pub async fn search_entities(&self, novel_id: &str, keyword: &str) -> Result<Value> {
        Ok(serde_json::json!({"entities": []}))
    }
}
