# Solidity (Nomic) - Zed extension

A Solidity extension for [Zed](https://zed.dev) powered by
[`@nomicfoundation/solidity-language-server`](https://www.npmjs.com/package/@nomicfoundation/solidity-language-server).

## What it does

- Starts the Nomic Foundation Solidity language server over stdio.
- Installs `@nomicfoundation/solidity-language-server` through Zed's npm helper when missing.
- Supports Solidity and Yul syntax highlighting.
- Adds highlighting for Solidity built-ins such as `msg.sender`, `block.timestamp`, `tx.origin`,
  `require`, `keccak256`, and `ecrecover`.

The Nomic language server is expected to handle Hardhat projects and its own workspace/project
discovery. This extension starts the language server directly and does not synthesize compiler
settings.

## Install (Dev Extension)

1. In Zed: command palette -> **zed: install dev extension** -> select this folder.
2. Disable any other Solidity extension if two Solidity language servers start for the same file.

No Python toolchain is required.

## Settings

By default no configuration is needed. The extension uses Zed's bundled Node runtime and installs:

```text
@nomicfoundation/solidity-language-server@0.8.25
```

To use your own server binary instead, configure:

```json
{
  "lsp": {
    "nomic-solidity": {
      "binary": {
        "path": "/abs/path/to/nomicfoundation-solidity-language-server"
      }
    }
  }
}
```

The custom binary is launched with `--stdio`.
