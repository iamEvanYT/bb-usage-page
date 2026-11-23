import assert from "node:assert/strict";
import { test } from "node:test";
import {
  displayHomePath,
  isPathWithin,
  normalizeHostPath,
  pathBasename,
  pathSegments,
} from "./host-path";

test("Windows paths split, match, and label correctly on any platform", () => {
  assert.deepEqual(pathSegments("C:\\Users\\me\\app"), ["C:", "Users", "me", "app"]);
  assert.equal(pathBasename("C:\\Users\\me\\app\\"), "app");
  assert.equal(pathBasename("C:\\"), "");
  assert.equal(pathBasename("/Users/me/app"), "app");

  assert.equal(isPathWithin("C:\\Users\\Me\\App\\src", "c:\\users\\me\\app"), true);
  assert.equal(isPathWithin("C:/Users/me/app", "C:\\Users\\me\\app\\"), true);
  assert.equal(isPathWithin("C:\\Users\\me\\application", "C:\\Users\\me\\app"), false);
  assert.equal(isPathWithin("C:\\anything", "C:\\"), true);
  // POSIX paths stay case-sensitive and never match Windows roots.
  assert.equal(isPathWithin("/Users/me/App", "/Users/me/app"), false);
  assert.equal(isPathWithin("/work/app/src", "/work/app"), true);
  assert.equal(isPathWithin("/work/app", "C:\\work\\app"), false);
  assert.equal(isPathWithin("/anything", "/"), true);
});

test("normalizeHostPath tidies absolute paths from either platform", () => {
  assert.equal(normalizeHostPath("C:/Users//me/app/"), "C:\\Users\\me\\app");
  assert.equal(normalizeHostPath("c:"), "c:\\");
  assert.equal(normalizeHostPath("\\\\server\\share\\dir\\"), "\\\\server\\share\\dir");
  assert.equal(normalizeHostPath("/work//app/"), "/work/app");
  assert.equal(normalizeHostPath("/"), "/");
  assert.equal(normalizeHostPath("relative/dir"), "");
});

test("displayHomePath abbreviates the machine's own home directory", () => {
  assert.equal(
    displayHomePath("C:\\Users\\me\\.codex\\sessions", "C:\\Users\\me"),
    "~\\.codex\\sessions",
  );
  assert.equal(displayHomePath("/home/me/.claude/projects", "/home/me"), "~/.claude/projects");
  assert.equal(displayHomePath("/srv/data", "/home/me"), "/srv/data");
});
