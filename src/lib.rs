use std::{env, fs, path::Path};

use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

const PACKAGE_NAME: &str = "@nomicfoundation/solidity-language-server";
const PACKAGE_VERSION: &str = "0.8.25";
const SERVER_SCRIPT: &str =
    "node_modules/@nomicfoundation/solidity-language-server/out/index.js";
const PROXY_SRC: &str = include_str!("../proxy/nomic-lsp-proxy.mjs");
const PROXY_FILE: &str = "nomic-lsp-proxy.mjs";

struct SolidityNomicExtension;

impl SolidityNomicExtension {
    fn prepend_node_dir_to_path(&self, env: &mut Vec<(String, String)>, node: &str) {
        let Some(node_dir) = Path::new(node).parent() else {
            return;
        };
        let node_dir = node_dir.to_string_lossy();
        let path_separator = if cfg!(windows) { ";" } else { ":" };

        if let Some((_, path)) = env.iter_mut().find(|(key, _)| key == "PATH") {
            *path = format!("{node_dir}{path_separator}{path}");
        } else {
            env.push(("PATH".to_string(), node_dir.to_string()));
        }
    }

    fn configured_binary(
        &self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Option<String> {
        LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.binary)
            .and_then(|binary| binary.path)
    }

    fn server_script_path(&self) -> Result<String> {
        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;
        if installed_version.as_deref() != Some(PACKAGE_VERSION) {
            zed::npm_install_package(PACKAGE_NAME, PACKAGE_VERSION)?;
        }

        let extension_dir = env::current_dir()
            .map_err(|err| format!("could not resolve extension directory: {err}"))?;
        Ok(extension_dir
            .join(SERVER_SCRIPT)
            .to_string_lossy()
            .to_string())
    }

    fn proxy_script_path(&self) -> Result<String> {
        let extension_dir = env::current_dir()
            .map_err(|err| format!("could not resolve extension directory: {err}"))?;
        let proxy_path = extension_dir.join(PROXY_FILE);
        fs::write(&proxy_path, PROXY_SRC)
            .map_err(|err| format!("failed to write Nomic proxy to {proxy_path:?}: {err}"))?;
        Ok(proxy_path.to_string_lossy().to_string())
    }
}

impl zed::Extension for SolidityNomicExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let mut env = worktree.shell_env();
        let node = zed::node_binary_path()?;
        self.prepend_node_dir_to_path(&mut env, &node);

        if let Some(binary) = self.configured_binary(language_server_id, worktree) {
            return Ok(zed::Command {
                command: binary,
                args: vec!["--stdio".to_string()],
                env,
            });
        }

        let server_script = self.server_script_path()?;
        let proxy_script = self.proxy_script_path()?;

        env.push((
            "SOLIDITY_LANGUAGE_SERVER_ROOT".to_string(),
            worktree.root_path(),
        ));

        Ok(zed::Command {
            command: node,
            args: vec![
                proxy_script,
                "--server".to_string(),
                server_script,
            ],
            env,
        })
    }
}

zed::register_extension!(SolidityNomicExtension);
