use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[cfg(target_os = "macos")]
use security_framework::item::{ItemClass, ItemSearchOptions, Limit};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub ui: UiSettings,
    pub window: WindowSettings,
    pub parsing: ParsingSettings,
    pub embedding: EmbeddingSettings,
    pub llm: LlmSettings,
    pub rag: RagSettings,
    pub sidecar: SidecarSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiSettings {
    pub theme: String,
    pub language: String,
    pub font_size: u32,
    pub font_family: String,
    pub graph: GraphUiSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphUiSettings {
    pub layout_algorithm: String,
    pub node_size: u32,
    pub edge_width: u32,
    pub color_scheme: String,
    pub show_labels: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowSettings {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsingSettings {
    pub auto_start_on_import: bool,
    pub chunk_size: usize,
    pub chunk_overlap: usize,
    pub max_threads: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingSettings {
    pub model_path: String,
    pub batch_size: usize,
    pub device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmSettings {
    pub default_config_id: String,
    pub parse_model_config_id: String,
    pub chat_model_config_id: String,
    pub max_context_tokens: usize,
    pub temperature: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagSettings {
    pub top_k: usize,
    pub enable_hybrid_search: bool,
    pub rerank_enabled: bool,
    pub min_relevance_score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarSettings {
    pub python_path: String,
    pub log_level: String,
    pub health_check_interval: u64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            ui: UiSettings {
                theme: "system".to_string(),
                language: "zh-CN".to_string(),
                font_size: 14,
                font_family: "system-ui".to_string(),
                graph: GraphUiSettings {
                    layout_algorithm: "force-directed".to_string(),
                    node_size: 40,
                    edge_width: 2,
                    color_scheme: "faction".to_string(),
                    show_labels: true,
                },
            },
            window: WindowSettings {
                width: 1400,
                height: 900,
                x: 100,
                y: 100,
                maximized: false,
            },
            parsing: ParsingSettings {
                auto_start_on_import: true,
                chunk_size: 512,
                chunk_overlap: 64,
                max_threads: 4,
            },
            embedding: EmbeddingSettings {
                model_path: "~/Library/Application Support/NovelReader/models/bge-m3".to_string(),
                batch_size: 32,
                device: "auto".to_string(),
            },
            llm: LlmSettings {
                default_config_id: "default".to_string(),
                parse_model_config_id: "default".to_string(),
                chat_model_config_id: "default".to_string(),
                max_context_tokens: 8192,
                temperature: 0.7,
            },
            rag: RagSettings {
                top_k: 5,
                enable_hybrid_search: true,
                rerank_enabled: true,
                min_relevance_score: 0.6,
            },
            sidecar: SidecarSettings {
                python_path: "sidecar/novel-ai-engine".to_string(),
                log_level: "info".to_string(),
                health_check_interval: 5000,
            },
        }
    }
}

pub struct ConfigManager {
    settings_path: std::path::PathBuf,
    settings: AppSettings,
}

impl ConfigManager {
    pub fn new(app_dir: &Path) -> Result<Self> {
        let settings_path = app_dir.join("settings.json");
        let settings = if settings_path.exists() {
            let content = std::fs::read_to_string(&settings_path)?;
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            AppSettings::default()
        };
        Ok(Self {
            settings_path,
            settings,
        })
    }

    pub fn get(&self) -> &AppSettings {
        &self.settings
    }

    pub fn update(&mut self, settings: AppSettings) -> Result<()> {
        let content = serde_json::to_string_pretty(&settings)?;
        std::fs::write(&self.settings_path, content)?;
        self.settings = settings;
        Ok(())
    }

    pub fn save(&self) -> Result<()> {
        let content = serde_json::to_string_pretty(&self.settings)?;
        std::fs::write(&self.settings_path, content)?;
        Ok(())
    }

    /// Store API key in macOS Keychain
    #[cfg(target_os = "macos")]
    pub fn store_api_key(config_id: &str, api_key: &str) -> Result<()> {
        use security_framework::os::macos::keychain::SecKeychain;

        let service = format!("novelreader.apikey.{}", config_id);
        let keychain = SecKeychain::default().context("Failed to open default keychain")?;

        // Delete existing item first
        let _ = Self::delete_api_key(config_id);

        keychain.add_generic_password(
            &service,
            "api_key",
            api_key.as_bytes(),
        ).context("Failed to store API key in keychain")?;

        Ok(())
    }

    /// Retrieve API key from macOS Keychain
    #[cfg(target_os = "macos")]
    pub fn get_api_key(config_id: &str) -> Result<Option<String>> {
        use security_framework::os::macos::keychain::SecKeychain;
        let service = format!("novelreader.apikey.{}", config_id);
        let keychain = SecKeychain::default().context("Failed to open default keychain")?;
        match keychain.find_generic_password(&service, "api_key") {
            Ok((password, _)) => Ok(Some(String::from_utf8_lossy(password.as_ref()).to_string())),
            Err(_) => Ok(None),
        }
    }

    /// Delete API key from macOS Keychain
    #[cfg(target_os = "macos")]
    pub fn delete_api_key(config_id: &str) -> Result<()> {
        use security_framework::os::macos::keychain::SecKeychain;
        let service = format!("novelreader.apikey.{}", config_id);
        let keychain = SecKeychain::default().context("Failed to open default keychain")?;
        // Overwrite with empty password to effectively delete
        let _ = keychain.add_generic_password(&service, "api_key", b"");
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    pub fn store_api_key(_config_id: &str, _api_key: &str) -> Result<()> {
        anyhow::bail!("Keychain storage only supported on macOS")
    }

    #[cfg(not(target_os = "macos"))]
    pub fn get_api_key(_config_id: &str) -> Result<Option<String>> {
        Ok(None)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn delete_api_key(_config_id: &str) -> Result<()> {
        Ok(())
    }
}
