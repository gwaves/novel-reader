use crate::db::AppDb;
use crate::models::*;
use anyhow::Result;

pub struct NovelService {
    db: AppDb,
}

impl NovelService {
    pub fn new(db: AppDb) -> Self {
        Self { db }
    }

    pub async fn import_novel(&self, file_path: &str) -> Result<Novel> {
        // TODO: implement import logic
        anyhow::bail!("not implemented")
    }

    pub async fn list_novels(&self) -> Result<Vec<Novel>> {
        self.db.list_novels()
    }

    pub async fn delete_novel(&self, novel_id: &str) -> Result<()> {
        self.db.delete_novel(novel_id)
    }
}
