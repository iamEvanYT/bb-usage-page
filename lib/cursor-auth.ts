import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type CursorAuthStatus =
  | "ok"
  | "missing"
  | "expired"
  | "invalid"
  | "unavailable";

export interface CursorAuth {
  databasePath: string;
  cookie: string;
  expiresAtMs: number | null;
}

export interface CursorAuthResult {
  status: CursorAuthStatus;
  auth: CursorAuth | null;
  databasePath: string;
  message: string | null;
}

const ACCESS_TOKEN_KEY = "cursorAuth/accessToken";

function missingDatabaseResult(databasePath: string): CursorAuthResult {
  return {
    status: "missing",
    auth: null,
    databasePath,
    message: "Cursor is not signed in on this machine.",
  };
}

export function defaultCursorDatabasePath(
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = NodeOS.homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return NodePath.join(
      homeDirectory,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }

  if (platform === "win32") {
    const appData =
      environment.APPDATA?.trim() ||
      NodePath.join(homeDirectory, "AppData", "Roaming");
    return NodePath.join(
      appData,
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    );
  }

  const configDirectory =
    environment.XDG_CONFIG_HOME?.trim() ||
    NodePath.join(homeDirectory, ".config");
  return NodePath.join(
    configDirectory,
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb",
  );
}

function expandHome(value: string): string {
  if (value === "~") return NodeOS.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    const relative = value.slice(2).split(/[\\/]/u).join(NodePath.sep);
    return NodePath.join(NodeOS.homedir(), relative);
  }
  return value;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as unknown;
    return typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function readAccessToken(databasePath: string): Promise<string | null> {
  // Keep node:sqlite out of the plugin's top-level module graph. Cursor is
  // optional, and older bb hosts should continue serving other providers.
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    // DatabaseSync.timeout is newer than node:sqlite itself. PRAGMA is
    // supported by older Node 22 releases and gives Cursor a moment to finish
    // a WAL/checkpoint write before we classify the read as unavailable.
    database.exec("PRAGMA busy_timeout = 1000");
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1")
      .get(ACCESS_TOKEN_KEY) as { value?: unknown } | undefined;
    return asString(row?.value)?.trim() || null;
  } finally {
    database.close();
  }
}

function databaseFailure(
  databasePath: string,
  error: unknown,
): CursorAuthResult {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  const details = `${code} ${message}`.toUpperCase();

  if (code === "ENOENT" || details.includes("SQLITE_CANTOPEN")) {
    let exists = false;
    try {
      exists = NodeFS.statSync(databasePath).isFile();
    } catch {
      // Missing/unreadable paths are both unavailable; only call a path
      // missing when the filesystem confirms that it is absent.
    }
    if (!exists) {
      return {
        status: "missing",
        auth: null,
        databasePath,
        message: "Cursor is not signed in on this machine.",
      };
    }
  }

  if (details.includes("SQLITE_BUSY") || details.includes("SQLITE_LOCKED")) {
    return {
      status: "unavailable",
      auth: null,
      databasePath,
      message: "Cursor's auth database is busy; try refreshing again.",
    };
  }

  if (details.includes("SQLITE_NOTADB")) {
    return {
      status: "unavailable",
      auth: null,
      databasePath,
      message: "Cursor's auth database is corrupt or not a SQLite database.",
    };
  }

  return {
    status: "unavailable",
    auth: null,
    databasePath,
    message: "Cursor auth database could not be read.",
  };
}

/**
 * Read Cursor's desktop auth without modifying Cursor's database.
 *
 * The dashboard endpoint accepts a WorkOS session cookie. Cursor's local
 * access JWT contains the user id needed to derive that cookie. This is an
 * intentionally small adapter around an undocumented Cursor convention; all
 * callers must handle a non-ok result as a normal unavailable source.
 */
export async function readCursorAuth(options?: {
  databasePath?: string;
  nowMs?: number;
}): Promise<CursorAuthResult> {
  const configuredPath = options?.databasePath?.trim();
  const databasePath = expandHome(configuredPath || defaultCursorDatabasePath());
  const nowMs = options?.nowMs ?? Date.now();

  try {
    if (!NodeFS.statSync(databasePath).isFile()) {
      return missingDatabaseResult(databasePath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return missingDatabaseResult(databasePath);
    }
    return databaseFailure(databasePath, error);
  }

  let accessToken: string | null;
  try {
    accessToken = await readAccessToken(databasePath);
  } catch (error) {
    return databaseFailure(databasePath, error);
  }

  if (accessToken === null) {
    return {
      status: "missing",
      auth: null,
      databasePath,
      message: "Cursor access credentials were not found.",
    };
  }

  const payload = decodeJwtPayload(accessToken);
  const subject = typeof payload?.sub === "string" ? payload.sub : null;
  const userId = subject?.slice(subject.lastIndexOf("|") + 1) ?? "";
  const expiresAtMs =
    typeof payload?.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1_000
      : null;

  if (userId.length === 0) {
    return {
      status: "invalid",
      auth: null,
      databasePath,
      message: "Cursor access credentials have an unrecognized format.",
    };
  }

  if (expiresAtMs !== null && expiresAtMs <= nowMs) {
    return {
      status: "expired",
      auth: null,
      databasePath,
      message:
        "Cursor access credentials have expired; open Cursor to refresh them.",
    };
  }

  return {
    status: "ok",
    databasePath,
    message: null,
    auth: {
      databasePath,
      // The dashboard's web app encodes the separator in this cookie value.
      cookie: encodeURIComponent(`${userId}::${accessToken}`),
      expiresAtMs,
    },
  };
}
