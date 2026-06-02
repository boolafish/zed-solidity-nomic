#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverIndex = process.argv.indexOf("--server");
if (serverIndex === -1 || !process.argv[serverIndex + 1]) {
  process.stderr.write("usage: nomic-lsp-proxy.mjs --server <server-script>\n");
  process.exit(1);
}

const serverScript = process.argv[serverIndex + 1];
const server = spawn(process.execPath, [serverScript, "--stdio"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

const clientRequests = new Map();
const serverRequests = new Map();
const documents = new Map();
let nextServerId = 1_000_000;

function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
}

function writeClient(msg) {
  process.stdout.write(encode(msg));
}

function writeServer(msg) {
  server.stdin.write(encode(msg));
}

function createReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        throw new Error("missing Content-Length header");
      }
      const length = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (buffer.length < messageEnd) return;
      const message = JSON.parse(buffer.slice(messageStart, messageEnd).toString());
      buffer = buffer.slice(messageEnd);
      onMessage(message);
    }
  };
}

function uriToPath(uri) {
  if (!uri?.startsWith("file://")) return null;
  return fileURLToPath(uri);
}

function pathToUri(filePath) {
  return pathToFileURL(filePath).toString();
}

function wordAt(text, position) {
  const line = text.split(/\r?\n/u)[position.line] ?? "";
  let start = Math.min(position.character, line.length);
  let end = start;
  while (start > 0 && /[A-Za-z0-9_$]/u.test(line[start - 1])) start--;
  while (end < line.length && /[A-Za-z0-9_$]/u.test(line[end])) end++;
  return line.slice(start, end);
}

function parseImports(text) {
  const imports = [];
  const namedImport =
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;/gu;
  for (const match of text.matchAll(namedImport)) {
    const specifiers = match[1].split(",").map((part) => {
      const pieces = part.trim().split(/\s+as\s+/u);
      const imported = pieces[0]?.trim();
      const local = (pieces[1] ?? pieces[0])?.trim();
      return { imported, local };
    });
    imports.push({ path: match[2], specifiers });
  }
  const plainImport = /import\s+["']([^"']+)["']\s*;/gu;
  for (const match of text.matchAll(plainImport)) {
    imports.push({ path: match[1], specifiers: [] });
  }
  return imports;
}

function resolveImport(fromFile, importPath) {
  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    const resolved = path.resolve(path.dirname(fromFile), importPath);
    return fs.existsSync(resolved) ? resolved : null;
  }

  let dir = path.dirname(fromFile);
  while (true) {
    const candidate = path.join(dir, "node_modules", importPath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function declarationRange(text, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const declaration = new RegExp(
    `\\b(?:abstract\\s+contract|contract|interface|library|struct|enum|error|event|modifier|function)\\s+(${escaped})\\b`,
    "u",
  );
  const lines = text.split(/\r?\n/u);
  for (let line = 0; line < lines.length; line++) {
    const match = lines[line].match(declaration);
    if (!match || match.index === undefined) continue;
    const character = match.index + match[0].lastIndexOf(symbol);
    return {
      start: { line, character },
      end: { line, character: character + symbol.length },
    };
  }
  return null;
}

function importedFiles(fromFile, text, maxDepth = 3) {
  const result = [];
  const seen = new Set([fromFile]);
  const queue = [{ file: fromFile, text, depth: 0 }];

  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;

    for (const importDecl of parseImports(current.text)) {
      const targetFile = resolveImport(current.file, importDecl.path);
      if (!targetFile || seen.has(targetFile) || !fs.existsSync(targetFile)) continue;

      seen.add(targetFile);
      result.push(targetFile);

      const targetText = fs.readFileSync(targetFile, "utf8");
      queue.push({
        file: targetFile,
        text: targetText,
        depth: current.depth + 1,
      });
    }
  }

  return result;
}

function fallbackDefinition(params) {
  const uri = params?.textDocument?.uri;
  const position = params?.position;
  if (!uri || !position) return null;

  const fromFile = uriToPath(uri);
  const text = documents.get(uri) ?? (fromFile && fs.existsSync(fromFile)
    ? fs.readFileSync(fromFile, "utf8")
    : null);
  if (!fromFile || !text) return null;

  const localSymbol = wordAt(text, position);
  if (!localSymbol) return null;

  for (const importDecl of parseImports(text)) {
    const specifier = importDecl.specifiers.find((item) => item.local === localSymbol);
    if (!specifier) continue;

    const targetFile = resolveImport(fromFile, importDecl.path);
    if (!targetFile) return null;
    const targetText = fs.readFileSync(targetFile, "utf8");
    const range = declarationRange(targetText, specifier.imported);
    if (!range) return null;
    return { uri: pathToUri(targetFile), range };
  }

  for (const targetFile of importedFiles(fromFile, text)) {
    const targetText = fs.readFileSync(targetFile, "utf8");
    const range = declarationRange(targetText, localSymbol);
    if (range) return { uri: pathToUri(targetFile), range };
  }

  return null;
}

function shouldFallback(result) {
  if (result == null) return true;
  if (Array.isArray(result)) return result.length === 0;
  return result.uri === "file:///" || result.targetUri === "file:///";
}

process.stdin.on("data", createReader((message) => {
  if (message.method === "textDocument/didOpen") {
    documents.set(message.params.textDocument.uri, message.params.textDocument.text);
  } else if (message.method === "textDocument/didChange") {
    const uri = message.params.textDocument.uri;
    const fullText = message.params.contentChanges.find((change) => change.text && !change.range);
    if (fullText) documents.set(uri, fullText.text);
  } else if (message.method === "textDocument/didClose") {
    documents.delete(message.params.textDocument.uri);
  }

  if (message.id != null && message.method === "textDocument/definition") {
    const serverId = nextServerId++;
    clientRequests.set(serverId, {
      clientId: message.id,
      method: message.method,
      params: message.params,
    });
    writeServer({ ...message, id: serverId });
    return;
  }

  if (message.id != null && !message.method && serverRequests.has(message.id)) {
    const serverId = serverRequests.get(message.id);
    serverRequests.delete(message.id);
    writeServer({ ...message, id: serverId });
    return;
  }

  writeServer(message);
}));

server.stdout.on("data", createReader((message) => {
  if (message.id != null && clientRequests.has(message.id)) {
    const request = clientRequests.get(message.id);
    clientRequests.delete(message.id);
    let result = message.result;
    if (request.method === "textDocument/definition" && shouldFallback(result)) {
      result = fallbackDefinition(request.params) ?? result;
    }
    writeClient({ ...message, id: request.clientId, result });
    return;
  }

  if (message.id != null && message.method) {
    const clientId = nextServerId++;
    serverRequests.set(clientId, message.id);
    writeClient({ ...message, id: clientId });
    return;
  }

  if (
    message.method === "custom/validation-job-status" &&
    message.params?.validationRun === false &&
    message.params?.reason === "Couldn't load the project config file. Please make sure the config file is valid."
  ) {
    return;
  }

  if (
    message.method === "window/showMessage" &&
    typeof message.params?.message === "string" &&
    message.params.message.includes("Couldn't load the project config file")
  ) {
    return;
  }

  writeClient(message);
}));

server.on("exit", (code) => {
  process.exit(code ?? 0);
});
