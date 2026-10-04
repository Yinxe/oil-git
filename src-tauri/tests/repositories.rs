use oil_git_lib::git::Git;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    repo: PathBuf,
    git: Git,
}
impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let repo = dunce::canonicalize(temp.path())
            .unwrap()
            .join("项目 with space");
        fs::create_dir(&repo).unwrap();
        let git = Git::discover().unwrap().0;
        let fixture = Self {
            _temp: temp,
            repo,
            git,
        };
        fixture.cmd(&["init", "-b", "main"]);
        fixture.cmd(&["config", "user.name", "验证用户"]);
        fixture.cmd(&["config", "user.email", "test@example.invalid"]);
        fixture.cmd(&["config", "core.autocrlf", "false"]);
        fixture
    }
    fn cmd(&self, args: &[&str]) -> String {
        self.git.text(&self.repo, args, false).unwrap()
    }
    fn write(&self, path: &str, content: &str) {
        fs::write(self.repo.join(path), content).unwrap();
    }
    fn commit(&self, message: &str) -> String {
        self.cmd(&["add", "."]);
        self.cmd(&["commit", "-m", message]);
        self.cmd(&["rev-parse", "HEAD"])
    }
    fn page(&self) -> oil_git_lib::git::HistoryPage {
        let s = self.git.snapshot(&self.repo).unwrap();
        self.git
            .history(&self.repo, "all", 0, &s.history_revision)
            .unwrap()
    }
}
fn bytes(path: impl AsRef<Path>) -> Vec<u8> {
    fs::read(path).unwrap()
}
#[cfg(unix)]
fn tree_bytes(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn visit(root: &Path, current: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
        for entry in fs::read_dir(current).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            if metadata.file_type().is_symlink() {
                files.push((
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    fs::read_link(path)
                        .unwrap()
                        .to_string_lossy()
                        .as_bytes()
                        .to_vec(),
                ));
            } else if metadata.is_dir() {
                visit(root, &path, files);
            } else if metadata.is_file() {
                files.push((
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    fs::read(path).unwrap(),
                ));
            }
        }
    }
    let mut files = Vec::new();
    visit(root, root, &mut files);
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}
fn file_rows(
    files: &[oil_git_lib::git::FileState],
) -> Vec<(String, Option<String>, String, bool, bool)> {
    files
        .iter()
        .map(|file| {
            (
                file.path.clone(),
                file.old_path.clone(),
                file.xy.clone(),
                file.staged,
                file.unstaged,
            )
        })
        .collect()
}
#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}
#[test]
fn open_unborn_paths_and_missing_git() {
    let f = Fixture::new();
    fs::create_dir(f.repo.join("子目录")).unwrap();
    assert_eq!(f.git.normalize(&f.repo.join("子目录")).unwrap(), f.repo);
    let s = f.git.snapshot(&f.repo).unwrap();
    assert!(s.head.is_none());
    assert_eq!(s.branch.as_deref(), Some("main"));
    assert!(f.page().commits.is_empty());
    let empty = f._temp.path().join("empty");
    fs::create_dir(&empty).unwrap();
    assert_eq!(f.git.normalize(&empty).unwrap_err().kind, "notRepository");
    f.git.text(&empty, &["init", "--bare"], false).unwrap();
    assert_eq!(f.git.normalize(&empty).unwrap_err().kind, "bare");
    let absent = Git::new(PathBuf::from("definitely-no-git-viewer-binary"));
    assert_eq!(
        absent
            .text(&f.repo, &["--version"], false)
            .unwrap_err()
            .kind,
        "gitUnavailable"
    );
    let removed = f.repo.join("does-not-exist");
    assert_eq!(f.git.normalize(&removed).unwrap_err().kind, "missing");
    #[cfg(not(windows))]
    {
        let trailing = f._temp.path().join("trailing space ");
        fs::create_dir(&trailing).unwrap();
        f.git
            .text(&trailing, &["init", "-b", "main"], false)
            .unwrap();
        assert_eq!(
            f.git.normalize(&trailing).unwrap(),
            dunce::canonicalize(&trailing).unwrap()
        );
    }
}
#[test]
fn staged_unstaged_hidden_renames_binary_and_read_only() {
    let f = Fixture::new();
    f.write("中文 文件.txt", "original\n");
    f.write(".env.example", "first\n");
    let first = f.commit("初始版本");
    assert!(f
        .git
        .commit(&f.repo, &first)
        .unwrap()
        .comparison
        .contains("首次"));
    f.write("中文 文件.txt", "staged\n");
    f.cmd(&["add", "中文 文件.txt"]);
    f.write("中文 文件.txt", "working\n");
    f.write(".env.example", "second\n");
    f.write("new.txt", "new\n");
    fs::write(f.repo.join("image.bin"), [1, 0, 2]).unwrap();
    f.write("large.txt", &"long line\n".repeat(60_000));
    let s = f.git.snapshot(&f.repo).unwrap();
    let file = s.files.iter().find(|x| x.path == "中文 文件.txt").unwrap();
    assert!(file.staged && file.unstaged);
    let staged = f
        .git
        .diff(&f.repo, "staged", "中文 文件.txt", None)
        .unwrap();
    assert!(staged.patch.contains("+staged"));
    assert!(!staged.patch.contains("+working"));
    let unstaged = f
        .git
        .diff(&f.repo, "unstaged", "中文 文件.txt", None)
        .unwrap();
    assert!(unstaged.patch.contains("+working"));
    assert!(unstaged.patch.contains("-staged"));
    assert!(
        f.git
            .diff(&f.repo, "unstaged", "image.bin", None)
            .unwrap()
            .binary
    );
    assert!(
        f.git
            .diff(&f.repo, "unstaged", "large.txt", None)
            .unwrap()
            .truncated
    );
    let before_index = bytes(f.repo.join(".git/index"));
    let before_head = bytes(f.repo.join(".git/HEAD"));
    let before_file = bytes(f.repo.join("中文 文件.txt"));
    f.git.snapshot(&f.repo).unwrap();
    f.page();
    f.git.commit(&f.repo, &first).unwrap();
    f.git
        .diff(&f.repo, "commit", "中文 文件.txt", Some(&first))
        .unwrap();
    assert_eq!(bytes(f.repo.join(".git/index")), before_index);
    assert_eq!(bytes(f.repo.join(".git/HEAD")), before_head);
    assert_eq!(bytes(f.repo.join("中文 文件.txt")), before_file);
    f.cmd(&["reset", "--hard"]);
    f.cmd(&["mv", "中文 文件.txt", "新的名字.txt"]);
    let s = f.git.snapshot(&f.repo).unwrap();
    assert!(s
        .files
        .iter()
        .any(|x| x.path == "新的名字.txt" && x.old_path.as_deref() == Some("中文 文件.txt")));
    let renamed = f.commit("重命名");
    let detail = f.git.commit(&f.repo, &renamed).unwrap();
    assert!(detail
        .files
        .iter()
        .any(|x| x.old_path.as_deref() == Some("中文 文件.txt")));
    let rename_view = f
        .git
        .commit_view_at_revision(&f.repo, &renamed, Some("新的名字.txt"), None)
        .unwrap();
    assert_eq!(rename_view.file_path.as_deref(), Some("新的名字.txt"));
    assert!(rename_view
        .detail
        .files
        .iter()
        .any(|file| file.old_path.as_deref() == Some("中文 文件.txt")));
    assert!(rename_view.diff.is_some());
    f.cmd(&["rm", "新的名字.txt"]);
    let deleted = f.commit("删除文件");
    assert!(f
        .git
        .diff(&f.repo, "commit", "新的名字.txt", Some(&deleted))
        .unwrap()
        .patch
        .contains("-original"));
}

#[cfg(unix)]
#[test]
fn active_clean_and_process_filters_are_rejected_before_any_repo_write() {
    for operation in ["clean", "process"] {
        let f = Fixture::new();
        f.write("tracked.txt", "before\n");
        f.write(".gitattributes", "*.txt filter=review\n");
        f.commit("filtered baseline");

        let marker = f.repo.join(".git/filter-writes.txt");
        let helper = f._temp.path().join(format!("{operation}-filter.sh"));
        fs::write(
            &helper,
            format!(
                "#!/bin/sh\nprintf invoked >> {}\ncat\n",
                shell_quote(&marker.to_string_lossy())
            ),
        )
        .unwrap();
        make_executable(&helper);
        f.git
            .text(
                &f.repo,
                &[
                    "config",
                    &format!("filter.review.{operation}"),
                    helper.to_str().unwrap(),
                ],
                false,
            )
            .unwrap();

        let before = tree_bytes(&f.repo);
        let error = match f.git.snapshot(&f.repo) {
            Ok(_) => panic!("active {operation} filter must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error.kind, "unsafeFilter", "{operation}");
        let error = match f.git.diff(&f.repo, "unstaged", "tracked.txt", None) {
            Ok(_) => panic!("active {operation} filter must be rejected for worktree diffs"),
            Err(error) => error,
        };
        assert_eq!(error.kind, "unsafeFilter", "{operation}");
        assert!(!marker.exists(), "{operation} helper must never execute");
        assert_eq!(tree_bytes(&f.repo), before, "{operation}");
    }
}

#[cfg(unix)]
#[test]
fn unused_global_filter_does_not_block_a_read_only_snapshot() {
    let f = Fixture::new();
    f.write("plain.txt", "plain\n");
    f.commit("plain baseline");
    let home = f._temp.path().join("alternate-home");
    fs::create_dir(&home).unwrap();
    let unused_helper = f._temp.path().join("unused-filter.sh");
    let marker = f._temp.path().join("unused-filter-ran");
    fs::write(
        &unused_helper,
        format!(
            "#!/bin/sh\nprintf invoked >> {}\ncat\n",
            shell_quote(&marker.to_string_lossy())
        ),
    )
    .unwrap();
    make_executable(&unused_helper);
    fs::write(
        home.join(".gitconfig"),
        format!(
            "[filter \"unused\"]\n\tclean = {}\n",
            unused_helper.to_string_lossy()
        ),
    )
    .unwrap();
    let wrapper = f._temp.path().join("git-with-home.sh");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nHOME={}\nexport HOME\nunset XDG_CONFIG_HOME\nexec {} \"$@\"\n",
            shell_quote(&home.to_string_lossy()),
            shell_quote(&f.git.binary.to_string_lossy())
        ),
    )
    .unwrap();
    make_executable(&wrapper);
    let git = Git::new(wrapper);
    assert_eq!(git.snapshot(&f.repo).unwrap().files.len(), 0);
    assert!(!marker.exists());
}

#[cfg(unix)]
#[test]
fn repeated_unused_filter_names_do_not_spawn_per_file_config_reads() {
    let f = Fixture::new();
    for index in 0..100 {
        f.write(&format!("tracked-{index:03}.txt"), "baseline\n");
    }
    f.write(".gitattributes", "*.txt filter=unused\n");
    f.commit("one unused filter across many paths");

    let counter = f._temp.path().join("git-invocations");
    let wrapper = f._temp.path().join("counting-git.sh");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nprintf x >> {}\nGIT_CONFIG_GLOBAL=/dev/null\nGIT_CONFIG_NOSYSTEM=1\nexport GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM\nexec {} \"$@\"\n",
            shell_quote(&counter.to_string_lossy()),
            shell_quote(&f.git.binary.to_string_lossy())
        ),
    )
    .unwrap();
    make_executable(&wrapper);
    let git = Git::new(wrapper);
    let snapshot = git.snapshot(&f.repo).unwrap();
    assert!(snapshot.files.is_empty());
    let invocations = fs::metadata(&counter).unwrap().len();
    println!("100 个同名 unused filter 属性：{invocations} 个 Git 进程");
    assert!(
        invocations < 40,
        "100 paths with one unused filter spawned {invocations} Git processes"
    );
}

#[cfg(unix)]
#[test]
fn inherited_git_environment_cannot_redirect_repository_or_replace_behavior() {
    if let Ok(repo_b) = std::env::var("OIL_GIT_TEST_TARGET_REPO") {
        let git = Git::new(PathBuf::from(
            std::env::var_os("OIL_GIT_TEST_BINARY").unwrap(),
        ));
        let repo_b = PathBuf::from(repo_b);
        let expected_head = std::env::var("OIL_GIT_TEST_EXPECTED_HEAD").unwrap();
        let snapshot = git.snapshot(&repo_b).unwrap();
        assert_eq!(Path::new(&snapshot.path), repo_b);
        assert_eq!(snapshot.branch.as_deref(), Some("beta"));
        assert_eq!(snapshot.head.as_deref(), Some(expected_head.as_str()));
        let history = git
            .history(&repo_b, "all", 0, &snapshot.history_revision)
            .unwrap();
        assert_eq!(history.commits[0].subject, "replacement from B");
        return;
    }

    let f = Fixture::new();
    f.write("from-a.txt", "repository A\n");
    f.cmd(&["switch", "-c", "alpha"]);
    f.commit("repository A");

    let repo_b = f._temp.path().join("repository-b");
    fs::create_dir(&repo_b).unwrap();
    let repo_b = dunce::canonicalize(repo_b).unwrap();
    f.git.text(&repo_b, &["init", "-b", "beta"], false).unwrap();
    f.git
        .text(&repo_b, &["config", "user.name", "验证用户"], false)
        .unwrap();
    f.git
        .text(
            &repo_b,
            &["config", "user.email", "test@example.invalid"],
            false,
        )
        .unwrap();
    fs::write(repo_b.join("from-b.txt"), "repository B\n").unwrap();
    f.git.text(&repo_b, &["add", "."], false).unwrap();
    f.git
        .text(&repo_b, &["commit", "-m", "repository B"], false)
        .unwrap();
    f.git
        .text(&repo_b, &["config", "core.useReplaceRefs", "true"], false)
        .unwrap();
    let original = f.git.text(&repo_b, &["rev-parse", "HEAD"], false).unwrap();
    let tree = f
        .git
        .text(&repo_b, &["rev-parse", "HEAD^{tree}"], false)
        .unwrap();
    let replacement = f
        .git
        .text(
            &repo_b,
            &["commit-tree", &tree, "-m", "replacement from B"],
            false,
        )
        .unwrap();
    f.git
        .text(&repo_b, &["replace", &original, &replacement], false)
        .unwrap();

    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "inherited_git_environment_cannot_redirect_repository_or_replace_behavior",
            "--nocapture",
        ])
        .env("OIL_GIT_TEST_TARGET_REPO", &repo_b)
        .env("OIL_GIT_TEST_BINARY", &f.git.binary)
        .env("OIL_GIT_TEST_EXPECTED_HEAD", &original)
        .env("GIT_DIR", f.repo.join(".git"))
        .env("GIT_WORK_TREE", &f.repo)
        .env("GIT_INDEX_FILE", f.repo.join(".git/index"))
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "core.useReplaceRefs")
        .env("GIT_CONFIG_VALUE_0", "false")
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn submodule_head_change_invalidates_the_working_revision() {
    let f = Fixture::new();
    let submodule = f._temp.path().join("submodule-source");
    fs::create_dir(&submodule).unwrap();
    f.git
        .text(&submodule, &["init", "-b", "main"], false)
        .unwrap();
    f.git
        .text(&submodule, &["config", "user.name", "验证用户"], false)
        .unwrap();
    f.git
        .text(
            &submodule,
            &["config", "user.email", "test@example.invalid"],
            false,
        )
        .unwrap();
    fs::write(submodule.join("tracked.txt"), "same tree\n").unwrap();
    f.git.text(&submodule, &["add", "."], false).unwrap();
    f.git
        .text(&submodule, &["commit", "-m", "submodule base"], false)
        .unwrap();
    f.git
        .text(
            &f.repo,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                submodule.to_str().unwrap(),
                "nested",
            ],
            false,
        )
        .unwrap();
    f.git
        .text(&f.repo, &["config", "diff.submodule", "diff"], false)
        .unwrap();
    f.commit("record submodule");

    let nested_path = f.repo.join("nested");
    // A clone does not inherit its source repository's local author identity.
    for (key, value) in [
        ("user.name", "验证用户"),
        ("user.email", "test@example.invalid"),
    ] {
        f.git
            .text(&nested_path, &["config", key, value], false)
            .unwrap();
    }
    let before = f.git.snapshot(&f.repo).unwrap();
    let before_head = f
        .git
        .text(&nested_path, &["rev-parse", "HEAD"], false)
        .unwrap();
    f.git
        .text(
            &nested_path,
            &["commit", "--allow-empty", "-m", "empty one"],
            false,
        )
        .unwrap();
    let middle = f.git.snapshot(&f.repo).unwrap();
    let middle_metadata = fs::metadata(&nested_path).unwrap();
    let middle_head = f
        .git
        .text(&nested_path, &["rev-parse", "HEAD"], false)
        .unwrap();
    f.git
        .text(
            &nested_path,
            &["commit", "--allow-empty", "-m", "empty two"],
            false,
        )
        .unwrap();
    let after = f.git.snapshot(&f.repo).unwrap();
    let after_metadata = fs::metadata(&nested_path).unwrap();
    let after_head = f
        .git
        .text(&nested_path, &["rev-parse", "HEAD"], false)
        .unwrap();

    assert_ne!(before_head, middle_head);
    assert_ne!(middle_head, after_head);
    assert_eq!(file_rows(&middle.files), file_rows(&after.files));
    assert_ne!(before.changes_revision, middle.changes_revision);
    assert_ne!(middle.changes_revision, after.changes_revision);
    assert_eq!(middle_metadata.len(), after_metadata.len());
    assert_eq!(
        middle_metadata.modified().unwrap(),
        after_metadata.modified().unwrap()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(middle_metadata.ctime(), after_metadata.ctime());
        assert_eq!(middle_metadata.ctime_nsec(), after_metadata.ctime_nsec());
    }

    let tracked = nested_path.join("tracked.txt");
    fs::write(&tracked, "edit-one\n").unwrap();
    let dirty_one = f.git.snapshot(&f.repo).unwrap();
    let dirty_one_metadata = fs::metadata(&nested_path).unwrap();
    let dirty_one_head = f
        .git
        .text(&nested_path, &["rev-parse", "HEAD"], false)
        .unwrap();
    let dirty_one_diff = f.git.diff(&f.repo, "unstaged", "nested", None).unwrap();

    fs::write(&tracked, "edit-two\n").unwrap();
    let dirty_two = f.git.snapshot(&f.repo).unwrap();
    let dirty_two_metadata = fs::metadata(&nested_path).unwrap();
    let dirty_two_head = f
        .git
        .text(&nested_path, &["rev-parse", "HEAD"], false)
        .unwrap();
    let dirty_two_diff = f.git.diff(&f.repo, "unstaged", "nested", None).unwrap();

    assert_eq!(dirty_one_head, dirty_two_head);
    assert_eq!(dirty_one_head, after_head);
    assert_eq!(file_rows(&dirty_one.files), file_rows(&dirty_two.files));
    assert_ne!(dirty_one.changes_revision, dirty_two.changes_revision);
    assert!(dirty_one_diff.patch.contains("+edit-one"));
    assert!(dirty_two_diff.patch.contains("+edit-two"));
    assert!(!dirty_two_diff.patch.contains("+edit-one"));
    assert_eq!(dirty_one_metadata.len(), dirty_two_metadata.len());
    assert_eq!(
        dirty_one_metadata.modified().unwrap(),
        dirty_two_metadata.modified().unwrap()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(dirty_one_metadata.ctime(), dirty_two_metadata.ctime());
        assert_eq!(
            dirty_one_metadata.ctime_nsec(),
            dirty_two_metadata.ctime_nsec()
        );
    }
}

#[cfg(unix)]
#[test]
fn timeout_covers_descendants_that_keep_git_pipes_open() {
    let f = Fixture::new();
    f.write("file.txt", "baseline\n");
    f.commit("baseline");
    let real_git = f.git.binary.clone();
    let wrapper = f._temp.path().join("git-with-pipe-holder.sh");
    let child_pid = f._temp.path().join("pipe-holder.pid");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\n{} \"$@\"\nresult=$?\nsleep 12 &\necho $! > {}\nexit $result\n",
            shell_quote(&real_git.to_string_lossy()),
            shell_quote(&child_pid.to_string_lossy())
        ),
    )
    .unwrap();
    make_executable(&wrapper);
    let wrapped = Git::new(wrapper);
    let start = Instant::now();
    let error = wrapped.text(&f.repo, &["--version"], false).unwrap_err();
    let elapsed = start.elapsed();
    assert_eq!(error.kind, "timeout");
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "elapsed: {elapsed:?}"
    );
    assert!(child_pid.is_file());
    assert!(Git::new(real_git)
        .text(&f.repo, &["--version"], false)
        .unwrap()
        .starts_with("git version"));
}

#[test]
fn binary_markers_inside_text_hunks_do_not_hide_the_diff() {
    let f = Fixture::new();
    f.write("markers.txt", "baseline\n");
    f.commit("text baseline");
    f.write(
        "markers.txt",
        "Binary files a and b differ\nGIT binary patch\nordinary text\n",
    );
    let diff = f
        .git
        .diff(&f.repo, "unstaged", "markers.txt", None)
        .unwrap();
    assert!(!diff.binary);
    assert!(diff.patch.contains("+Binary files a and b differ"));
    assert!(diff.patch.contains("+GIT binary patch"));
}

#[test]
fn combined_commit_view_selects_valid_files_tracks_history_and_is_read_only() {
    let f = Fixture::new();
    f.write("a.txt", "root a\n");
    f.write("b.txt", "root b\n");
    let root = f.commit("root");
    let root_snapshot = f.git.snapshot(&f.repo).unwrap();
    let root_view = f
        .git
        .commit_view_at_revision(&f.repo, &root, None, Some(&root_snapshot.history_revision))
        .unwrap();
    assert_eq!(root_view.detail.comparison, "首次提交，全部为新增内容");
    assert_eq!(root_view.file_path.as_deref(), Some("a.txt"));
    assert!(root_view.diff.as_ref().unwrap().patch.contains("+root a"));

    f.write("a.txt", "changed a\n");
    f.write("b.txt", "changed b\n");
    let changed = f.commit("change both files");
    let snapshot = f.git.snapshot(&f.repo).unwrap();
    let index_before = bytes(f.repo.join(".git/index"));
    let head_before = bytes(f.repo.join(".git/HEAD"));
    let a_before = bytes(f.repo.join("a.txt"));
    let b_before = bytes(f.repo.join("b.txt"));

    let selected = f
        .git
        .commit_view_at_revision(
            &f.repo,
            &changed,
            Some("b.txt"),
            Some(&snapshot.history_revision),
        )
        .unwrap();
    assert_eq!(selected.file_path.as_deref(), Some("b.txt"));
    assert!(selected.diff.as_ref().unwrap().patch.contains("+changed b"));
    assert!(!selected.diff.as_ref().unwrap().patch.contains("+changed a"));
    let default = f
        .git
        .commit_view_at_revision(&f.repo, &changed, None, Some(&snapshot.history_revision))
        .unwrap();
    assert_eq!(
        default.file_path.as_deref(),
        default.detail.files.first().map(|file| file.path.as_str())
    );
    assert_eq!(default.diff.is_some(), default.file_path.is_some());
    let wire = serde_json::to_value(&default).unwrap();
    assert!(wire.get("detail").is_some());
    assert!(wire.get("filePath").is_some());
    assert!(wire.get("diff").is_some());
    assert_eq!(
        f.git
            .commit_view_at_revision(
                &f.repo,
                &changed,
                Some("missing.txt"),
                Some(&snapshot.history_revision),
            )
            .err()
            .unwrap()
            .kind,
        "invalid"
    );
    assert_eq!(bytes(f.repo.join(".git/index")), index_before);
    assert_eq!(bytes(f.repo.join(".git/HEAD")), head_before);
    assert_eq!(bytes(f.repo.join("a.txt")), a_before);
    assert_eq!(bytes(f.repo.join("b.txt")), b_before);

    f.cmd(&["branch", "history-changed"]);
    assert_eq!(
        f.git
            .commit_view_at_revision(&f.repo, &changed, None, Some(&snapshot.history_revision))
            .err()
            .unwrap()
            .kind,
        "staleHistory"
    );
}

#[test]
fn same_length_rewrite_with_restored_mtime_changes_working_revision() {
    let f = Fixture::new();
    f.write("same.txt", "base\n");
    f.commit("base");

    let path = f.repo.join("same.txt");
    f.write("same.txt", "aaaa\n");
    let edited_metadata = fs::metadata(&path).unwrap();
    let original_mtime = edited_metadata.modified().unwrap();
    let restored_mtime = filetime::FileTime::from_last_modification_time(&edited_metadata);
    let before = f.git.snapshot(&f.repo).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(25));
    f.write("same.txt", "bbbb\n");
    filetime::set_file_mtime(&path, restored_mtime).unwrap();

    let after = f.git.snapshot(&f.repo).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), 5);
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        original_mtime
    );
    assert_eq!(before.files[0].xy, after.files[0].xy);
    assert_ne!(before.changes_revision, after.changes_revision);
}

#[cfg(unix)]
#[test]
fn snapshot_retries_when_index_changes_after_status_read() {
    let mut f = Fixture::new();
    f.write("tracked.txt", "base\n");
    f.commit("base");
    f.write("tracked.txt", "staged\n");

    let trigger = f._temp.path().join("stage-once");
    let wrapper = f._temp.path().join("git-wrapper.sh");
    let script = format!(
        "#!/bin/sh\nREAL_GIT={}\nREPO={}\nTRIGGER={}\nIS_STATUS=0\nfor arg in \"$@\"; do\n  if [ \"$arg\" = status ]; then IS_STATUS=1; fi\ndone\n\"$REAL_GIT\" \"$@\"\nresult=$?\nif [ \"$IS_STATUS\" = 1 ] && [ ! -e \"$TRIGGER\" ]; then\n  : > \"$TRIGGER\"\n  \"$REAL_GIT\" -C \"$REPO\" add -- tracked.txt\nfi\nexit \"$result\"\n",
        shell_quote(&f.git.binary.to_string_lossy()),
        shell_quote(&f.repo.to_string_lossy()),
        shell_quote(&trigger.to_string_lossy())
    );
    fs::write(&wrapper, script).unwrap();
    let mut permissions = fs::metadata(&wrapper).unwrap().permissions();
    use std::os::unix::fs::PermissionsExt;
    permissions.set_mode(0o755);
    fs::set_permissions(&wrapper, permissions).unwrap();
    f.git.binary = wrapper;

    let snapshot = f.git.snapshot(&f.repo).unwrap();
    let file = snapshot
        .files
        .iter()
        .find(|file| file.path == "tracked.txt")
        .unwrap();
    assert!(trigger.is_file());
    assert!(file.staged);
    assert!(!file.unstaged);

    let stable = f.git.snapshot(&f.repo).unwrap();
    assert_eq!(stable.changes_revision, snapshot.changes_revision);
    assert_eq!(stable.files[0].xy, snapshot.files[0].xy);
}
#[test]
fn branches_merge_stash_reset_detached_and_worktree() {
    let f = Fixture::new();
    f.write("base.txt", "base\n");
    let root = f.commit("root");
    f.cmd(&["switch", "-c", "feature"]);
    f.write("feature.txt", "feature\n");
    let feature = f.commit("feature");
    f.cmd(&["switch", "main"]);
    f.cmd(&["merge", "--ff-only", "feature"]);
    assert_eq!(f.page().commits.len(), 2);
    f.cmd(&["switch", "-c", "parallel", &root]);
    f.write("parallel.txt", "parallel");
    let parallel = f.commit("parallel");
    f.cmd(&["switch", "main"]);
    f.cmd(&["merge", "--no-ff", "parallel", "-m", "merge"]);
    let merge = f.cmd(&["rev-parse", "HEAD"]);
    let d = f.git.commit(&f.repo, &merge).unwrap();
    assert_eq!(d.commit.parents, vec![feature, parallel]);
    assert_eq!(d.files.len(), 1);
    let merge_revision = f.git.snapshot(&f.repo).unwrap().history_revision;
    let merge_view = f
        .git
        .commit_view_at_revision(&f.repo, &merge, Some("parallel.txt"), Some(&merge_revision))
        .unwrap();
    assert_eq!(merge_view.detail.commit.parents, d.commit.parents);
    assert_eq!(merge_view.detail.files.len(), 1);
    assert!(merge_view.diff.unwrap().patch.contains("+parallel"));
    f.write("base.txt", "stash edit");
    f.cmd(&["stash", "push", "-m", "临时修改"]);
    assert_eq!(f.git.snapshot(&f.repo).unwrap().stashes.len(), 1);
    assert_eq!(f.page().commits.len(), 4); // stash 内部提交不混入历史
    let s = f.git.snapshot(&f.repo).unwrap();
    f.cmd(&["reset", "--soft", "HEAD~1"]);
    assert_ne!(
        s.history_revision,
        f.git.snapshot(&f.repo).unwrap().history_revision
    );
    f.cmd(&["switch", "--detach", &root]);
    assert!(f.git.snapshot(&f.repo).unwrap().branch.is_none());
    let tree = f._temp.path().join("second-tree");
    f.cmd(&[
        "worktree",
        "add",
        "-b",
        "other",
        tree.to_str().unwrap(),
        &root,
    ]);
    let trees = f.git.worktrees(&f.repo).unwrap();
    assert_eq!(trees.len(), 2);
    assert!(trees.iter().any(|w| w.current));
    let normalized = f.git.normalize(&tree).unwrap();
    assert!(f.git.snapshot(&normalized).unwrap().files.is_empty());
    assert!(tree.join(".git").is_file());
}

#[test]
fn history_revision_tracks_replace_refs_shallow_and_grafts() {
    let f = Fixture::new();
    f.write("history.txt", "one\n");
    let first = f.commit("first");
    f.write("history.txt", "two\n");
    let second = f.commit("second");
    let tree = f.cmd(&["rev-parse", &format!("{first}^{{tree}}")]);
    let replacement = f.cmd(&["commit-tree", &tree, "-m", "replacement"]);

    f.write("history.txt", "staged\n");
    f.cmd(&["add", "history.txt"]);
    f.write("history.txt", "working\n");
    let before_replace = f.git.snapshot(&f.repo).unwrap();
    let before_file = before_replace
        .files
        .iter()
        .find(|file| file.path == "history.txt")
        .unwrap();
    assert_eq!(before_file.xy, "MM");
    let before_staged = f
        .git
        .diff(&f.repo, "staged", "history.txt", None)
        .unwrap()
        .patch;
    assert!(before_staged.contains("-two"));
    f.cmd(&["replace", &second, &replacement]);
    let after_replace = f.git.snapshot(&f.repo).unwrap();
    assert_ne!(
        before_replace.history_revision,
        after_replace.history_revision
    );
    assert_ne!(
        before_replace.changes_revision,
        after_replace.changes_revision
    );
    assert_eq!(
        after_replace
            .files
            .iter()
            .find(|file| file.path == "history.txt")
            .unwrap()
            .xy,
        before_file.xy
    );
    let after_staged = f
        .git
        .diff(&f.repo, "staged", "history.txt", None)
        .unwrap()
        .patch;
    assert!(after_staged.contains("-one"));
    assert_eq!(
        f.git
            .commit_at_revision(&f.repo, &second, Some(&after_replace.history_revision))
            .unwrap()
            .commit
            .subject,
        "replacement"
    );
    assert_eq!(
        f.git
            .commit_at_revision(&f.repo, &second, Some(&before_replace.history_revision))
            .err()
            .unwrap()
            .kind,
        "staleHistory"
    );
    assert_eq!(
        f.git
            .diff_at_revision(
                &f.repo,
                "commit",
                "history.txt",
                Some(&second),
                Some(&before_replace.history_revision),
            )
            .err()
            .unwrap()
            .kind,
        "staleHistory"
    );
    assert!(after_replace
        .refs
        .iter()
        .all(|r| !r.full_name.starts_with("refs/replace/")));
    let replaced_page = f
        .git
        .history(&f.repo, "all", 0, &after_replace.history_revision)
        .unwrap();
    assert_eq!(replaced_page.commits[0].subject, "replacement");

    f.cmd(&["replace", "-d", &second]);
    let before_shallow = f.git.snapshot(&f.repo).unwrap();
    let shallow = f.repo.join(".git/shallow");
    fs::write(&shallow, format!("{second}\n")).unwrap();
    let after_shallow = f.git.snapshot(&f.repo).unwrap();
    assert_ne!(
        before_shallow.history_revision,
        after_shallow.history_revision
    );
    let shallow_page = f
        .git
        .history(&f.repo, "all", 0, &after_shallow.history_revision)
        .unwrap();
    assert_eq!(shallow_page.commits.len(), 1);

    fs::remove_file(&shallow).unwrap();
    let before_grafts = f.git.snapshot(&f.repo).unwrap();
    let grafts = f.repo.join(".git/info/grafts");
    fs::write(&grafts, format!("{second}\n")).unwrap();
    let after_grafts = f.git.snapshot(&f.repo).unwrap();
    assert_ne!(
        before_grafts.history_revision,
        after_grafts.history_revision
    );
    let graft_page = f
        .git
        .history(&f.repo, "all", 0, &after_grafts.history_revision)
        .unwrap();
    assert!(graft_page
        .commits
        .iter()
        .find(|c| c.hash == second)
        .unwrap()
        .parents
        .is_empty());
}
#[test]
fn conflicts_and_rebase_state() {
    let f = Fixture::new();
    f.write("conflict.txt", "first\n");
    f.commit("base");
    f.cmd(&["switch", "-c", "feature"]);
    f.write("conflict.txt", "feature\n");
    f.commit("feature");
    f.cmd(&["switch", "main"]);
    f.write("conflict.txt", "main\n");
    f.commit("main");
    f.git.text(&f.repo, &["merge", "feature"], true).unwrap();
    let s = f.git.snapshot(&f.repo).unwrap();
    assert_eq!(s.operation.as_deref(), Some("合并"));
    assert!(s.files[0].conflict);
    let d = f
        .git
        .diff(&f.repo, "conflict", "conflict.txt", None)
        .unwrap();
    let c = d.conflict.unwrap();
    assert_eq!(c.blocks.len(), 1);
    assert_eq!(c.blocks[0].start_line, 1);
    assert_eq!(c.blocks[0].ours[0].text, "main");
    assert_eq!(c.blocks[0].theirs[0].text, "feature");
    f.write("conflict.txt", "resolved\n");
    assert!(f.git.snapshot(&f.repo).unwrap().files[0].conflict);
    assert!(f
        .git
        .diff(&f.repo, "conflict", "conflict.txt", None)
        .unwrap()
        .conflict
        .unwrap()
        .blocks
        .is_empty());
    f.cmd(&["add", "conflict.txt"]);
    assert!(!f.git.snapshot(&f.repo).unwrap().files[0].conflict);
    f.cmd(&["merge", "--abort"]);
    f.cmd(&["switch", "feature"]);
    f.git.text(&f.repo, &["rebase", "main"], true).unwrap();
    assert_eq!(
        f.git.snapshot(&f.repo).unwrap().operation.as_deref(),
        Some("变基")
    );
}
#[test]
fn fetch_updates_remote_records_without_working_files() {
    let f = Fixture::new();
    f.write("file.txt", "one\n");
    f.commit("base");
    let remote = f._temp.path().join("remote.git");
    fs::create_dir(&remote).unwrap();
    f.git.text(&remote, &["init", "--bare"], false).unwrap();
    f.cmd(&["remote", "add", "origin", remote.to_str().unwrap()]);
    f.cmd(&["push", "-u", "origin", "main"]);
    let second = f._temp.path().join("second");
    f.cmd(&["clone", remote.to_str().unwrap(), second.to_str().unwrap()]);
    f.git.text(&second, &["switch", "main"], false).unwrap();
    f.git
        .text(&second, &["config", "user.name", "验证用户"], false)
        .unwrap();
    f.git
        .text(
            &second,
            &["config", "user.email", "test@example.invalid"],
            false,
        )
        .unwrap();
    fs::write(second.join("file.txt"), "two\n").unwrap();
    f.git.text(&second, &["add", "."], false).unwrap();
    f.git
        .text(&second, &["commit", "-m", "remote update"], false)
        .unwrap();
    f.git.text(&second, &["push"], false).unwrap();
    let before = f.cmd(&["rev-parse", "HEAD"]);
    f.cmd(&["fetch"]);
    let s = f.git.snapshot(&f.repo).unwrap();
    assert_eq!(s.behind, 1);
    assert_eq!(s.head.unwrap(), before);
    assert_eq!(bytes(f.repo.join("file.txt")), b"one\n");
    f.cmd(&["pull", "--ff-only"]);
    assert_eq!(bytes(f.repo.join("file.txt")), b"two\n");
}
#[test]
fn history_pagination_on_ten_thousand_commits() {
    let f = Fixture::new();
    let mut stream = String::new();
    for i in 1..=10_000 {
        let message = format!("commit {i}");
        stream.push_str(&format!("commit refs/heads/main\nmark :{i}\ncommitter 验证用户 <test@example.invalid> {} +0000\ndata {}\n{message}\n",1_700_000_000+i,message.len()));
        if i > 1 {
            stream.push_str(&format!("from :{}\n", i - 1));
        }
        stream.push('\n');
    }
    stream.push_str("done\n");
    let mut child = Command::new(&f.git.binary)
        .arg("-C")
        .arg(&f.repo)
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stream.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
    let start = Instant::now();
    let s = f.git.snapshot(&f.repo).unwrap();
    let first = f
        .git
        .history(&f.repo, "all", 0, &s.history_revision)
        .unwrap();
    let elapsed = start.elapsed();
    println!("一万提交：快照与第一页读取 {elapsed:?}");
    assert_eq!(first.commits.len(), 100);
    assert!(first.has_more);
    assert_eq!(first.commits[0].subject, "commit 10000");
    let next = f
        .git
        .history(&f.repo, "all", 100, &s.history_revision)
        .unwrap();
    assert_eq!(next.commits[0].hash, first.commits[99].parents[0]);
    f.cmd(&["branch", "another"]);
    assert_eq!(
        f.git
            .history(&f.repo, "all", 100, &s.history_revision)
            .err()
            .unwrap()
            .kind,
        "staleHistory"
    );
}
