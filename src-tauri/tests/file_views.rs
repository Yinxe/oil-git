use base64::{engine::general_purpose::STANDARD, Engine};
use oil_git_lib::git::{Git, LineOriginRequest};
use std::{fs, path::PathBuf};
use tempfile::TempDir;

struct Repo {
    _temp: TempDir,
    path: PathBuf,
    git: Git,
}
impl Repo {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let path = dunce::canonicalize(temp.path()).unwrap();
        let git = Git::discover().unwrap().0;
        let repo = Self {
            _temp: temp,
            path,
            git,
        };
        repo.cmd(&["init", "-b", "main"]);
        repo.cmd(&["config", "user.name", "Alice"]);
        repo.cmd(&["config", "user.email", "alice@example.invalid"]);
        repo
    }
    fn cmd(&self, args: &[&str]) -> String {
        self.git.text(&self.path, args, false).unwrap()
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        fs::write(self.path.join(name), bytes).unwrap();
    }
    fn commit(&self, message: &str) -> String {
        self.cmd(&["add", "."]);
        self.cmd(&["commit", "-m", message]);
        self.cmd(&["rev-parse", "HEAD"])
    }
    fn origin(
        &self,
        mode: &str,
        side: &str,
        line: usize,
        commit: Option<&str>,
        path: &str,
    ) -> oil_git_lib::git::LineOrigin {
        let snapshot = self.git.snapshot(&self.path).unwrap();
        self.git
            .line_origin(
                &self.path,
                &LineOriginRequest {
                    mode: mode.into(),
                    path: path.into(),
                    side: side.into(),
                    line,
                    commit: commit.map(str::to_owned),
                    history_revision: Some(snapshot.history_revision),
                    changes_revision: Some(snapshot.changes_revision),
                },
            )
            .unwrap()
    }
}
fn png() -> Vec<u8> {
    STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=").unwrap()
}
fn payload(side: &oil_git_lib::git::FilePreview, before: bool) -> Vec<u8> {
    let side = if before {
        side.before.as_ref()
    } else {
        side.after.as_ref()
    }
    .unwrap();
    STANDARD
        .decode(side.data_url.as_ref().unwrap().split_once(',').unwrap().1)
        .unwrap()
}
#[test]
fn image_versions_follow_index_worktree_and_commit_including_rename_and_delete() {
    let repo = Repo::new();
    let first = png();
    let mut second = first.clone();
    second.extend(b"second");
    let mut third = first.clone();
    third.extend(b"third");
    repo.write("图片.png", &first);
    let initial = repo.commit("initial image");
    repo.write("图片.png", &second);
    repo.cmd(&["add", "图片.png"]);
    repo.write("图片.png", &third);
    let index_before = fs::read(repo.path.join(".git/index")).unwrap();
    let config_before = fs::read(repo.path.join(".git/config")).unwrap();
    let staged = repo
        .git
        .diff(&repo.path, "staged", "图片.png", None)
        .unwrap()
        .preview
        .unwrap();
    assert_eq!(payload(&staged, true), first);
    assert_eq!(payload(&staged, false), second);
    let working = repo
        .git
        .diff(&repo.path, "unstaged", "图片.png", None)
        .unwrap()
        .preview
        .unwrap();
    assert_eq!(payload(&working, true), second);
    assert_eq!(payload(&working, false), third);
    assert_eq!(working.after.unwrap().width, Some(1));
    let root = repo
        .git
        .diff(&repo.path, "commit", "图片.png", Some(&initial))
        .unwrap()
        .preview
        .unwrap();
    assert!(root.before.is_none());
    assert_eq!(payload(&root, false), first);
    assert_eq!(
        fs::read(repo.path.join(".git/index")).unwrap(),
        index_before
    );
    assert_eq!(
        fs::read(repo.path.join(".git/config")).unwrap(),
        config_before
    );
    repo.commit("update image");
    repo.cmd(&["mv", "图片.png", "改名.png"]);
    let renamed = repo.commit("rename image");
    let history = repo
        .git
        .diff(&repo.path, "commit", "改名.png", Some(&renamed))
        .unwrap()
        .preview
        .unwrap();
    assert_eq!(payload(&history, true), third);
    assert_eq!(payload(&history, false), third);
    fs::remove_file(repo.path.join("改名.png")).unwrap();
    let deleted = repo
        .git
        .diff(&repo.path, "unstaged", "改名.png", None)
        .unwrap()
        .preview
        .unwrap();
    assert!(deleted.before.is_some());
    assert!(deleted.after.is_none());
}
#[test]
fn untracked_images_svg_and_unknown_binary_have_bounded_real_previews() {
    let repo = Repo::new();
    repo.write("new.png", &png());
    let diff = repo
        .git
        .diff(&repo.path, "unstaged", "new.png", None)
        .unwrap();
    assert!(!diff.truncated);
    assert!(diff.preview.unwrap().before.is_none());
    repo.write("shape.svg", b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\"/></svg>");
    let svg = repo
        .git
        .diff(&repo.path, "unstaged", "shape.svg", None)
        .unwrap();
    assert!(svg.patch.contains("<svg"));
    assert_eq!(svg.preview.unwrap().after.unwrap().mime, "image/svg+xml");
    repo.write("data.bin", &vec![0; 6000]);
    let binary = repo
        .git
        .diff(&repo.path, "unstaged", "data.bin", None)
        .unwrap()
        .preview
        .unwrap()
        .after
        .unwrap();
    assert_eq!(binary.size, 6000);
    assert_eq!(binary.hex.len(), 8192);
    assert!(binary.hex_truncated);
    assert!(binary.data_url.is_none());
    let mut big = png();
    big.resize(8 * 1024 * 1024 + 1, 0);
    repo.write("big.png", &big);
    let limited = repo
        .git
        .diff(&repo.path, "unstaged", "big.png", None)
        .unwrap()
        .preview
        .unwrap()
        .after
        .unwrap();
    assert!(limited.data_url.is_none());
    assert!(limited.note.unwrap().contains("8 MiB"));
}
#[test]
fn utf16_and_explicit_binary_unicode_text_use_real_line_differences() {
    let repo = Repo::new();
    let encode = |text: &str| {
        [
            vec![0xff, 0xfe],
            text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        ]
        .concat()
    };
    repo.write("中文.txt", &encode("第一行\n旧内容\n"));
    repo.commit("unicode");
    repo.write("中文.txt", &encode("第一行\n新内容\n"));
    let diff = repo
        .git
        .diff(&repo.path, "unstaged", "中文.txt", None)
        .unwrap();
    assert!(!diff.binary);
    assert!(diff.preview.is_none());
    assert_eq!(diff.encoding.as_deref(), Some("UTF-16 LE"));
    assert!(diff.patch.contains("-旧内容\n+新内容"));
    assert!(!diff.truncated);
    repo.write("中文.txt", "第一行\n旧内容\n".as_bytes());
    let encoding_only = repo
        .git
        .diff(&repo.path, "unstaged", "中文.txt", None)
        .unwrap();
    assert!(encoding_only.preview.is_some());
    assert!(encoding_only.note.as_deref().unwrap().contains("编码"));
    assert_eq!(encoding_only.encoding.as_deref(), Some("UTF-16 LE → UTF-8"));
    repo.write(".gitattributes", b"forced.txt -diff\n");
    repo.write("forced.txt", b"old\n");
    repo.commit("forced binary");
    repo.write("forced.txt", b"new\n");
    let forced = repo
        .git
        .diff(&repo.path, "unstaged", "forced.txt", None)
        .unwrap();
    assert!(!forced.binary);
    assert!(forced.patch.contains("-old\n+new"));
}
#[test]
fn line_authors_distinguish_committed_staged_and_uncommitted_lines() {
    let repo = Repo::new();
    repo.write(
        "code.ts",
        b"const one = 1;\nconst two = 2;\nconst three = 3;\n",
    );
    let first = repo.commit("Alice creates code");
    repo.cmd(&["config", "user.name", "Bob"]);
    repo.cmd(&["config", "user.email", "bob@example.invalid"]);
    repo.write(
        "code.ts",
        b"const one = 1;\nconst two = 20;\nconst three = 3;\n",
    );
    let second = repo.commit("Bob changes second line");
    let detail = repo.git.commit(&repo.path, &second).unwrap();
    let detail_json = serde_json::to_value(detail).unwrap();
    assert_eq!(detail_json["authorEmail"], "bob@example.invalid");
    assert_eq!(detail_json["committerEmail"], "bob@example.invalid");
    let alice = repo.origin("commit", "after", 1, Some(&second), "code.ts");
    let bob = repo.origin("commit", "after", 2, Some(&second), "code.ts");
    assert_eq!(alice.author, "Alice");
    assert_eq!(alice.hash.as_deref(), Some(first.as_str()));
    assert_eq!(bob.author, "Bob");
    assert_eq!(bob.email, "bob@example.invalid");
    let parent = repo.origin("commit", "before", 2, Some(&second), "code.ts");
    assert_eq!(parent.author, "Alice");
    repo.write(
        "code.ts",
        b"const one = 1;\nconst two = 200;\nconst three = 3;\n",
    );
    repo.cmd(&["add", "code.ts"]);
    assert!(repo
        .origin("staged", "after", 2, None, "code.ts")
        .hash
        .is_none());
    assert_eq!(
        repo.origin("staged", "before", 2, None, "code.ts").author,
        "Bob"
    );
    repo.write(
        "code.ts",
        b"const one = 1;\nconst two = 200;\nconst three = 300;\n",
    );
    assert!(repo
        .origin("unstaged", "after", 3, None, "code.ts")
        .hash
        .is_none());
    assert_eq!(
        repo.origin("unstaged", "before", 3, None, "code.ts").author,
        "Alice"
    );
    let old = repo.git.snapshot(&repo.path).unwrap().changes_revision;
    repo.write("code.ts", b"changed again\n");
    let request = LineOriginRequest {
        mode: "unstaged".into(),
        path: "code.ts".into(),
        side: "after".into(),
        line: 1,
        commit: None,
        history_revision: None,
        changes_revision: Some(old),
    };
    assert_eq!(
        repo.git.line_origin(&repo.path, &request).unwrap_err().kind,
        "changed"
    );
}
