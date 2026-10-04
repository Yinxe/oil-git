// 在原生 runner 上检查实际安装包。所有 Git 写入只用于创建临时测试仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "artifact-dir": { type: "string" },
    report: { type: "string" },
  },
});
if (!values["artifact-dir"] || !values.report) {
  throw new Error("请指定 --artifact-dir 与 --report。");
}
const reportFile = path.resolve(values.report);
const report = {
  platform: process.platform,
  architecture: process.arch,
  status: "running",
  checks: [],
  limitations: ["未检查原生窗口、WebView 渲染、文件通知及视觉交互。"],
};
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
function filesUnder(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}
function fixtureContents(root) {
  return Object.fromEntries(
    filesUnder(root)
      .sort()
      .map((file) => [
        path.relative(root, file),
        createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      ]),
  );
}
function check(name, action) {
  action();
  report.checks.push(name);
}

let temporary;
let mounted = false;
let mountPoint;
try {
  assert.ok(["darwin", "win32"].includes(process.platform));
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "oil-git-installed-"));
  const candidates = filesUnder(path.resolve(values["artifact-dir"])).filter(
    (file) =>
      process.platform === "darwin"
        ? file.endsWith(".dmg")
        : file.endsWith("setup.exe"),
  );
  assert.equal(candidates.length, 1, "需要且只能提供一个当前平台的安装包");
  report.installer = path.basename(candidates[0]);
  report.installerSha256 = createHash("sha256")
    .update(fs.readFileSync(candidates[0]))
    .digest("hex");
  let executable;
  let resources;
  if (process.platform === "darwin") {
    mountPoint = path.join(temporary, "mount");
    fs.mkdirSync(mountPoint);
    run("hdiutil", [
      "attach",
      candidates[0],
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountPoint,
    ]);
    mounted = true;
    const app = path.join(temporary, "安装 with space", "oil-git.app");
    run("ditto", [path.join(mountPoint, "oil-git.app"), app]);
    run("hdiutil", ["detach", mountPoint]);
    mounted = false;
    executable = path.join(app, "Contents", "MacOS", "oil-git");
    resources = path.join(app, "Contents", "Resources");
    check("通用应用包含 arm64 与 x86_64", () => {
      const architectures = run("lipo", ["-archs", executable]).split(/\s+/);
      assert.ok(architectures.includes("arm64"));
      assert.ok(architectures.includes("x86_64"));
    });
  } else {
    assert.equal(
      process.env.GITHUB_ACTIONS,
      "true",
      "Windows 安装检查只在临时 GitHub runner 运行，避免改动本机的安装记录与快捷方式。",
    );
    resources = path.join(temporary, "安装 with space");
    // NSIS 的 /D 必须放最后，且参数不能加引号；它会读取余下的完整路径。
    run(candidates[0], ["/S", `/D=${resources}`], {
      timeout: 300_000,
      windowsVerbatimArguments: true,
    });
    executable = path.join(resources, "oil-git.exe");
  }
  check("安装后存在可执行文件", () => assert.ok(fs.existsSync(executable)));
  const cli = (args) => run(executable, args);
  const launcher =
    process.platform === "darwin"
      ? (args) =>
          run("/bin/sh", [path.join(resources, "bin", "oil-git"), ...args])
      : (args) =>
          run("powershell.exe", [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(resources, "bin", "oil-git.ps1"),
            ...args,
          ]);
  check("版本与帮助入口", () => {
    report.version = cli(["--version"]);
    assert.match(report.version, /^oil-git \d+\.\d+\.\d+/);
    assert.match(cli(["--help"]), /inspect/);
    assert.equal(launcher(["--version"]), report.version);
  });
  check("安装包内的 Skill 与发现入口一致", () => {
    const skillPath = cli(["skill", "--path"]);
    assert.equal(
      fs.realpathSync(skillPath),
      fs.realpathSync(path.join(resources, "skills", "oil-git", "SKILL.md")),
    );
    assert.equal(cli(["skill"]), fs.readFileSync(skillPath, "utf8").trim());
  });

  const repo = path.join(temporary, "项目 with space");
  fs.mkdirSync(repo);
  const git = (args) => run("git", ["-C", repo, ...args]);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "CI fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "core.autocrlf", "false"]);
  const subdir = path.join(repo, "源码");
  fs.mkdirSync(subdir);
  const source = path.join(subdir, "应用.ts");
  fs.writeFileSync(source, "export const value = 1;\n");
  git(["add", "."]);
  git(["commit", "-m", "首次提交"]);
  git(["branch", "feature/中文"]);
  git(["tag", "v0.1-fixture"]);
  fs.writeFileSync(source, "export const value = 2;\n");
  git(["add", "."]);
  fs.writeFileSync(source, "export const value = 3;\n");
  fs.writeFileSync(path.join(repo, "新文件.md"), "临时文件\n");
  const before = fixtureContents(repo);
  const inspect = (command, target) =>
    JSON.parse(command(["inspect", target, "--json"]));
  const verifySnapshot = (response) => {
    assert.equal(response.status, "ready");
    const snapshot = response.data;
    assert.equal(fs.realpathSync(snapshot.path), fs.realpathSync(repo));
    assert.equal(snapshot.branch, "main");
    assert.equal(snapshot.files.length, 2);
    const tracked = snapshot.files.find((file) => file.path === "源码/应用.ts");
    assert.ok(tracked?.staged && tracked?.unstaged);
    assert.ok(
      snapshot.files.find((file) => file.path === "新文件.md")?.untracked,
    );
    assert.ok(snapshot.refs.some((ref) => ref.name === "feature/中文"));
    assert.ok(snapshot.refs.some((ref) => ref.name === "v0.1-fixture"));
    assert.ok(snapshot.historyRevision && snapshot.changesRevision);
  };
  check("中文及空格路径，暂存与未暂存并存", () =>
    verifySnapshot(inspect(cli, repo)),
  );
  check("从子目录识别真实仓库", () => verifySnapshot(inspect(cli, subdir)));
  check("随包启动器支持 JSON 快照", () =>
    verifySnapshot(inspect(launcher, repo)),
  );
  check("无效目录返回 JSON 错误和非零退出码", () => {
    for (const command of [cli, launcher]) {
      for (const target of [temporary, path.join(temporary, "不存在")]) {
        assert.throws(
          () => inspect(command, target),
          (error) => {
            assert.equal(error.status, 2);
            const response = JSON.parse(error.stdout);
            assert.equal(response.status, "error");
            assert.ok(response.kind && response.message);
            return true;
          },
        );
      }
    }
  });
  check("读取前后文件、暂存区、引用和配置字节不变", () =>
    assert.deepEqual(fixtureContents(repo), before),
  );

  const lfsRepo = path.join(temporary, "LFS 项目 with space");
  fs.mkdirSync(lfsRepo);
  const lfsGit = (args) =>
    run("git", [
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.clean=",
      "-c",
      "filter.lfs.required=false",
      "-C",
      lfsRepo,
      ...args,
    ]);
  // 测试数据直接暂存标准指针，构造过程也不依赖安装 git-lfs。
  const stagePointers = () => lfsGit(["add", "."]);
  const pointer = (content) =>
    "version https://git-lfs.github.com/spec/v1\n" +
    `oid sha256:${createHash("sha256").update(content).digest("hex")}\n` +
    `size ${content.length}\n`;
  lfsGit(["init", "-b", "main"]);
  lfsGit(["config", "user.name", "CI fixture"]);
  lfsGit(["config", "user.email", "fixture@example.invalid"]);
  lfsGit(["config", "core.autocrlf", "false"]);
  lfsGit(["config", "filter.lfs.clean", "git-lfs clean -- %f"]);
  lfsGit(["config", "filter.lfs.smudge", "git-lfs smudge -- %f"]);
  lfsGit(["config", "filter.lfs.process", "git-lfs filter-process"]);
  lfsGit(["config", "filter.lfs.required", "true"]);
  fs.writeFileSync(
    path.join(lfsRepo, ".gitattributes"),
    "*.bin filter=lfs diff=lfs merge=lfs -text\n",
  );
  const lfsFile = path.join(lfsRepo, "中文 文件.bin");
  const original = Buffer.from("original\0LFS content\n");
  fs.writeFileSync(lfsFile, pointer(original));
  stagePointers();
  lfsGit(["commit", "-m", "LFS 首次提交"]);
  const inspectLfs = () => {
    const response = inspect(cli, lfsRepo);
    assert.equal(response.status, "ready");
    return response.data;
  };
  check("未下载对象的 LFS 指针保持干净且只读", () => {
    const unchanged = fixtureContents(lfsRepo);
    assert.equal(inspectLfs().files.length, 0);
    assert.deepEqual(fixtureContents(lfsRepo), unchanged);
  });
  fs.writeFileSync(lfsFile, original);
  // 在临时仓库记录已展开文件的 stat；手改指针后不暂存，Git 自身也会报 M。
  // 使用随包转换器构造同一对象，不依赖 git-lfs 或写入 LFS 对象库。
  const filterExecutable =
    process.platform === "win32"
      ? executable.replaceAll("\\", "/")
      : executable;
  const bundledFilter = `'${filterExecutable.replaceAll("'", "'\\''")}' __oil_lfs_filter_process`;
  lfsGit([
    "-c",
    `filter.lfs.process=${bundledFilter}`,
    "-c",
    "filter.lfs.required=true",
    "add",
    "--",
    "中文 文件.bin",
  ]);
  check("已展开 LFS 内容保持干净且不写对象", () => {
    const unchanged = fixtureContents(lfsRepo);
    assert.equal(inspectLfs().files.length, 0);
    assert.deepEqual(fixtureContents(lfsRepo), unchanged);
    assert.ok(!fs.existsSync(path.join(lfsRepo, ".git", "lfs")));
  });
  fs.writeFileSync(lfsFile, pointer(Buffer.from("staged\0content\n")));
  stagePointers();
  fs.writeFileSync(lfsFile, Buffer.from("working\0content\n"));
  check("LFS 暂存与未暂存独立识别且只读", () => {
    const unchanged = fixtureContents(lfsRepo);
    const files = inspectLfs().files;
    assert.equal(files.length, 1);
    assert.ok(files[0].staged && files[0].unstaged);
    assert.deepEqual(fixtureContents(lfsRepo), unchanged);
    assert.ok(!fs.existsSync(path.join(lfsRepo, ".git", "lfs")));
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (mounted) {
    try {
      run("hdiutil", ["detach", mountPoint]);
    } catch (error) {
      report.cleanupError = String(error);
      process.exitCode = 1;
    }
  }
  if (temporary) {
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch (error) {
      report.cleanupError = String(error);
      process.exitCode = 1;
    }
  }
  if (report.cleanupError) report.status = "failed";
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${report.platform} / ${report.architecture}: ${report.status}\n\n` +
        report.checks.map((name) => `- ✅ ${name}\n`).join("") +
        `\n${report.limitations.join("\n")}\n`,
    );
  }
}
