use std::path::PathBuf;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use serde_json::Value;

pub struct SidecarManager {
    _app_handle: AppHandle,
    app_dir: PathBuf,
    process: Option<Child>,
    socket_path: PathBuf,
}

impl SidecarManager {
    pub fn new(app_handle: AppHandle, app_dir: PathBuf) -> Self {
        let socket_path = app_dir.join("sidecar.sock");
        Self {
            _app_handle: app_handle,
            app_dir,
            process: None,
            socket_path,
        }
    }

    pub async fn start(&mut self) -> anyhow::Result<()> {
        // Clean up old socket
        if self.socket_path.exists() {
            let _ = std::fs::remove_file(&self.socket_path);
        }

        let sidecar_bin = self.app_dir.join("sidecar/novel-ai-engine");
        let server_py = self.app_dir.join("sidecar/src/server.py");
        let project_server_py = PathBuf::from("/Users/gwaves/code/my-reader/app/sidecar/src/server.py");

        let (program, args) = if sidecar_bin.exists() {
            (sidecar_bin.to_string_lossy().to_string(), vec![self.socket_path.to_string_lossy().to_string()])
        } else if server_py.exists() {
            ("python3".to_string(), vec![server_py.to_string_lossy().to_string(), self.socket_path.to_string_lossy().to_string()])
        } else if project_server_py.exists() {
            ("python3".to_string(), vec![project_server_py.to_string_lossy().to_string(), self.socket_path.to_string_lossy().to_string()])
        } else {
            anyhow::bail!("Sidecar not found: neither binary nor server.py exists")
        };

        let mut cmd = Command::new(&program);
        cmd.args(&args);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.current_dir(&self.app_dir);

        let child = cmd.spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn sidecar: {}", e))?;
        self.process = Some(child);

        // Wait for socket file to appear
        for _ in 0..30 {
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            if self.socket_path.exists() {
                return Ok(());
            }
        }

        anyhow::bail!("Sidecar failed to start within 6 seconds")
    }

    pub async fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(mut child) = self.process.take() {
            let _ = child.kill().await;
        }
        if self.socket_path.exists() {
            let _ = std::fs::remove_file(&self.socket_path);
        }
        Ok(())
    }

    pub async fn health_check(&self) -> bool {
        match self.send_request("system.health", Value::Object(Default::default())).await {
            Ok(res) => res.get("status").and_then(|s| s.as_str()) == Some("ok"),
            Err(_) => false,
        }
    }

    pub async fn send_request(
        &self,
        method: &str,
        params: Value,
    ) -> anyhow::Result<Value> {
        if !self.socket_path.exists() {
            anyhow::bail!("Sidecar socket not found at {:?}", self.socket_path);
        }

        let mut stream = UnixStream::connect(&self.socket_path)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to connect to sidecar socket: {}", e))?;

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": uuid::Uuid::new_v4().to_string(),
            "method": method,
            "params": params,
        });

        let payload = format!("{}\n", request);
        stream.write_all(payload.as_bytes()).await?;
        stream.flush().await?;

        // Read response (single line JSON-RPC)
        let mut buf = String::new();
        let mut byte_buf = [0u8; 1];
        loop {
            let n = stream.read(&mut byte_buf).await?;
            if n == 0 {
                break;
            }
            let ch = byte_buf[0] as char;
            if ch == '\n' {
                break;
            }
            buf.push(ch);
        }

        if buf.is_empty() {
            anyhow::bail!("Sidecar returned empty response");
        }

        let response: Value = serde_json::from_str(&buf)
            .map_err(|e| anyhow::anyhow!("Invalid JSON response from sidecar: {} | raw: {}", e, buf))?;

        if let Some(err) = response.get("error") {
            anyhow::bail!("Sidecar JSON-RPC error: {}", err);
        }

        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }
}
