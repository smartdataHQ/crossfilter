import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

var sandboxDirs = [];

function createConsumerSandbox() {
  var sandboxDir = mkdtempSync(join(tmpdir(), "crossfilter3-entry-"));
  var nodeModulesDir = join(sandboxDir, "node_modules");
  mkdirSync(nodeModulesDir);
  symlinkSync(process.cwd(), join(nodeModulesDir, "crossfilter3"));
  sandboxDirs.push(sandboxDir);
  return sandboxDir;
}

afterEach(function() {
  while (sandboxDirs.length) {
    rmSync(sandboxDirs.pop(), { force: true, recursive: true });
  }
});

describe("package entry points", function() {
  it("resolves the published package root for ESM consumers", function() {
    var sandboxDir = createConsumerSandbox();
    var output = execFileSync("node", [
      "--input-type=module",
      "-e",
      "import crossfilter from 'crossfilter3'; console.log(typeof crossfilter, crossfilter.version);"
    ], {
      cwd: sandboxDir,
      encoding: "utf8"
    }).trim();

    expect(output).toBe("function 3.0.2");
  });

  it("resolves the published package root for CommonJS consumers", function() {
    var sandboxDir = createConsumerSandbox();
    var output = execFileSync("node", [
      "-e",
      "const crossfilter = require('crossfilter3'); console.log(typeof crossfilter, crossfilter.version);"
    ], {
      cwd: sandboxDir,
      encoding: "utf8"
    }).trim();

    expect(output).toBe("function 3.0.2");
  });
});
