/**
 * Path helpers that work on any machine's paths, whatever platform the code
 * runs on. The server merges usage from other bb machines, so a macOS server
 * must still match, split, and label Windows paths such as `C:\Users\me\app`.
 */

const DRIVE_RE = /^[A-Za-z]:(?:[\\/]|$)/u;

/** `C:\...`, `C:/...`, or a UNC `\\server\share` path. */
export function isWindowsPath(path: string): boolean {
  return DRIVE_RE.test(path) || path.startsWith("\\\\");
}

/** The path's own separator: `\` for Windows paths, `/` otherwise. */
export function pathSeparator(path: string): "\\" | "/" {
  return isWindowsPath(path) ? "\\" : "/";
}

/** Path segments, splitting on both separators for Windows paths. */
export function pathSegments(path: string): string[] {
  return path.split(isWindowsPath(path) ? /[\\/]+/u : /\/+/u).filter(Boolean);
}

export function pathBasename(path: string): string {
  const segments = pathSegments(path);
  const last = segments[segments.length - 1] ?? "";
  // A bare drive such as `C:` is a root, not a folder name.
  return /^[A-Za-z]:$/u.test(last) && segments.length === 1 ? "" : last;
}

/** Comparison form: Windows paths use `\`, ignore case, and drop trailing separators. */
function comparisonKey(path: string): string {
  if (!isWindowsPath(path)) {
    return path.length > 1 ? path.replace(/\/+$/u, "") : path;
  }
  const unified = path.replace(/\//gu, "\\");
  const trimmed = /^[A-Za-z]:\\$/u.test(unified)
    ? unified
    : unified.replace(/\\+$/u, "");
  return trimmed.toLowerCase();
}

/** Whether `path` is `root` or lies beneath it, honoring Windows case rules. */
export function isPathWithin(path: string, root: string): boolean {
  if (path.length === 0 || root.length === 0) return false;
  if (isWindowsPath(path) !== isWindowsPath(root)) return false;
  const a = comparisonKey(path);
  const b = comparisonKey(root);
  if (a === b) return true;
  const separator = pathSeparator(root);
  return a.startsWith(b.endsWith(separator) ? b : `${b}${separator}`);
}

/** Whether `path` is absolute on the machine it came from. */
export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith("/") || isWindowsPath(path);
}

/**
 * Tidy an absolute path from any machine: collapse repeated separators and
 * drop trailing ones (keeping roots), using `\` for Windows paths. Relative
 * paths return "".
 */
export function normalizeHostPath(path: string): string {
  const trimmed = path.trim();
  if (!isAbsoluteHostPath(trimmed)) return "";
  if (!isWindowsPath(trimmed)) {
    const collapsed = trimmed.replace(/\/+/gu, "/");
    return collapsed.length > 1 ? collapsed.replace(/\/+$/u, "") : collapsed;
  }
  const unc = trimmed.startsWith("\\\\");
  const body = trimmed.replace(/[\\/]+/gu, "\\");
  const joined = unc ? `\\${body}` : body;
  if (/^[A-Za-z]:\\?$/u.test(joined)) return `${joined.slice(0, 2)}\\`;
  return joined.replace(/\\+$/u, "");
}

/** Show `path` with the machine's home directory abbreviated to `~`. */
export function displayHomePath(path: string, home: string): string {
  if (home.length === 0 || !isPathWithin(path, home)) return path;
  return `~${path.slice(normalizeHostPath(home).length)}`;
}
