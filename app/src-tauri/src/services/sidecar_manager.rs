use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use serde_json::Value;
use walkdir::WalkDir;

pub struct SidecarManager {
    app_handle: AppHandle,
    app_dir: PathBuf,
    process: Option<Child>,
    socket_path: PathBuf,
}

impl SidecarManager {
    pub fn new(app_handle: AppHandle, app_dir: PathBuf) -> Self {
        let socket_path = app_dir.join("sidecar.sock");
        Self {
            app_handle,
            app_dir,
            process: None,
            socket_path,
        }
    }

    /// 首次运行时自动部署 sidecar：从 app bundle resources 复制源码、创建 venv、安装依赖
    async fn ensure_deployed(&self) -> anyhow::Result<()> {
        let sidecar_dir = self.app_dir.join("sidecar");
        let server_py = sidecar_dir.join("src/server.py");

        // 如果已经部署过，直接返回
        if server_py.exists() {
            return Ok(());
        }

        println!("[Sidecar] First run detected, deploying sidecar...");

        // 1. 从 app bundle resources 复制 sidecar 源码
        let resource_dir = self.app_handle.path().resource_dir()
            .map_err(|e| anyhow::anyhow!("Failed to get resource dir: {}", e))?;
        let bundled_sidecar = resource_dir.join("sidecar");

        if !bundled_sidecar.exists() {
            anyhow::bail!("Bundled sidecar not found at {:?}", bundled_sidecar);
        }

        std::fs::create_dir_all(&sidecar_dir)?;
        copy_dir_all(&bundled_sidecar, &sidecar_dir)
            .map_err(|e| anyhow::anyhow!("Failed to copy sidecar: {}", e))?;

        println!("[Sidecar] Source copied to {:?}", sidecar_dir);

        // 2. 创建 Python 虚拟环境（优先使用 python3.11，避免 Python 3.14 兼容性问题）
        let venv_dir = sidecar_dir.join("venv");
        let venv_python = venv_dir.join("bin/python3");

        if !venv_python.exists() {
            // 尝试找到合适的 Python 版本
            let python_candidates = ["python3.11", "python3.12", "python3.10", "python3"];
            let mut chosen_python: Option<&str> = None;
            for py in &python_candidates {
                let check = Command::new("which").arg(py).output().await;
                if let Ok(out) = check {
                    if out.status.success() {
                        chosen_python = Some(py);
                        break;
                    }
                }
            }
            let python = chosen_python.ok_or_else(|| anyhow::anyhow!("No suitable Python found (tried python3.11, python3.12, python3.10, python3)"))?;
            println!("[Sidecar] Using {} to create virtual environment...", python);

            let output = Command::new(python)
                .args(["-m", "venv", venv_dir.to_string_lossy().as_ref()])
                .output()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to create venv: {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("venv creation failed: {}", stderr);
            }
            println!("[Sidecar] Virtual environment created");
        }

        // 3. 安装依赖
        let requirements = sidecar_dir.join("requirements.txt");
        if requirements.exists() {
            println!("[Sidecar] Installing Python dependencies...");
            let output = Command::new(venv_python.to_string_lossy().as_ref())
                .args(["-m", "pip", "install", "-r", requirements.to_string_lossy().as_ref()])
                .output()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to install dependencies: {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!("pip install failed: {}", stderr);
            }
            println!("[Sidecar] Dependencies installed");
        }

        println!("[Sidecar] Deployment complete");
        Ok(())
    }

    pub async fn start(&mut self) -> anyhow::Result<()> {
        // 首次运行时自动部署
        self.ensure_deployed().await?;

        let pid_file = self.app_dir.join("sidecar.pid");

        // 1. 尝试终止旧 sidecar 进程（避免重启后出现多实例）
        if pid_file.exists() {
            if let Ok(pid_str) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output().await;
                }
            }
            let _ = std::fs::remove_file(&pid_file);
        }

        // 2. 清理旧 socket
        if self.socket_path.exists() {
            let _ = std::fs::remove_file(&self.socket_path);
        }

        let sidecar_dir = self.app_dir.join("sidecar");
        let sidecar_bin = sidecar_dir.join("novel-ai-engine");
        let server_py = sidecar_dir.join("src/server.py");
        let venv_python = sidecar_dir.join("venv/bin/python3");

        let (program, args) = if sidecar_bin.exists() {
            (sidecar_bin.to_string_lossy().to_string(), vec![self.socket_path.to_string_lossy().to_string()])
        } else if server_py.exists() && venv_python.exists() {
            // 使用虚拟环境中的 Python
            (venv_python.to_string_lossy().to_string(), vec![
                server_py.to_string_lossy().to_string(),
                self.socket_path.to_string_lossy().to_string()
            ])
        } else if server_py.exists() {
            // 降级使用系统 Python3
            ("python3".to_string(), vec![
                server_py.to_string_lossy().to_string(),
                self.socket_path.to_string_lossy().to_string()
            ])
        } else {
            anyhow::bail!("Sidecar not found: neither binary nor server.py exists")
        };

        let mut cmd = Command::new(&program);
        cmd.args(&args);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.current_dir(&sidecar_dir);

        let child = cmd.spawn()
            .map_err(|e| anyhow::anyhow!("Failed to spawn sidecar: {}", e))?;

        // 记录 PID，便于下次启动时清理旧进程
        if let Some(pid) = child.id() {
            let _ = std::fs::write(&pid_file, pid.to_string());
        }
        self.process = Some(child);

        // Wait for socket file to appear
        for _ in 0..60 {
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            if self.socket_path.exists() {
                return Ok(());
            }
        }

        anyhow::bail!("Sidecar failed to start within 12 seconds")
    }

    pub async fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(mut child) = self.process.take() {
            let _ = child.kill().await;
        }
        if self.socket_path.exists() {
            let _ = std::fs::remove_file(&self.socket_path);
        }
        let pid_file = self.app_dir.join("sidecar.pid");
        if pid_file.exists() {
            let _ = std::fs::remove_file(&pid_file);
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

/// 递归复制目录
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in WalkDir::new(src) {
        let entry = entry?;
        let path = entry.path();
        let relative = path.strip_prefix(src).unwrap();
        let dest = dst.join(relative);

        if path.is_dir() {
            std::fs::create_dir_all(&dest)?;
        } else {
            std::fs::copy(path, dest)?;
        }
    }
    Ok(())
}
