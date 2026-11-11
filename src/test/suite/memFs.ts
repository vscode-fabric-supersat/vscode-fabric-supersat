import * as vscode from 'vscode';

/**
 * Minimal in-memory file system for tests that read and write files. Works in both the
 * desktop and web test hosts, which have no writable folder open. Register it under a
 * unique scheme with `vscode.workspace.registerFileSystemProvider`.
 */
export class MemFs implements vscode.FileSystemProvider {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>(['/']);
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const file = this.files.get(uri.path);
    if (file) {
      return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: file.byteLength };
    }
    if (this.dirs.has(uri.path)) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const prefix = uri.path.endsWith('/') ? uri.path : `${uri.path}/`;
    const children = (paths: Iterable<string>, type: vscode.FileType) =>
      [...paths]
        .filter((p) => p.startsWith(prefix) && p !== prefix && !p.slice(prefix.length).includes('/'))
        .map((p): [string, vscode.FileType] => [p.slice(prefix.length), type]);
    return [...children(this.dirs, vscode.FileType.Directory), ...children(this.files.keys(), vscode.FileType.File)];
  }

  createDirectory(uri: vscode.Uri): void {
    const parts = uri.path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      this.dirs.add(`/${parts.slice(0, i).join('/')}`);
    }
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const file = this.files.get(uri.path);
    if (!file) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return file;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    const parent = uri.path.slice(0, uri.path.lastIndexOf('/')) || '/';
    if (!this.dirs.has(parent)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.files.set(uri.path, content);
  }

  delete(uri: vscode.Uri): void {
    if (!this.files.delete(uri.path) && !this.dirs.delete(uri.path)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    this.writeFile(newUri, this.readFile(oldUri));
    this.files.delete(oldUri.path);
  }

  /** Test helper: the file's text, or `undefined` if it doesn't exist. */
  text(path: string): string | undefined {
    const file = this.files.get(path);
    return file && new TextDecoder().decode(file);
  }
}
