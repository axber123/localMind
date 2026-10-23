export const SUPPORTED_EXTENSIONS: Record<string, string> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.json': 'json',
  '.css': 'css',
  '.html': 'html',
  '.htm': 'html'
}

export const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.idea',
  '.vscode',
  '.pnpm-store',
  '.pnpm-cache'
])

export const MAX_SCAN_FILES = 10_000
export const MAX_PARSE_BYTES = 5 * 1024 * 1024
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
export const MAX_SCAN_DEPTH = 30

export function isSupportedFile(fileName: string): boolean {
  return extensionOf(fileName) in SUPPORTED_EXTENSIONS
}

export function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.')
  return index >= 0 ? fileName.slice(index).toLowerCase() : ''
}

export function languageOf(fileName: string): string {
  return SUPPORTED_EXTENSIONS[extensionOf(fileName)] ?? 'text'
}
