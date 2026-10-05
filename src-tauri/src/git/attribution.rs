use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineOriginRequest {
    pub mode: String,
    pub path: String,
    pub commit: Option<String>,
    pub side: String,
    pub line: usize,
    pub history_revision: Option<String>,
    pub changes_revision: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineOrigin {
    pub hash: Option<String>,
    pub author: String,
    pub email: String,
    pub timestamp: Option<i64>,
    pub subject: String,
    pub original_line: usize,
    pub line: usize,
    pub path: String,
}
impl Git {
    pub fn line_origin(&self, repo: &Path, request: &LineOriginRequest) -> Result<LineOrigin> {
        validate_relative(&request.path)?;
        if request.line == 0 || !["before", "after"].contains(&request.side.as_str()) {
            return Err(Error::new("invalid", "行号或比较侧无效。"));
        }
        self.reject_partial_clone(repo)?;
        let before = request.side == "before";
        let history = if request.mode == "commit" {
            self.check_expected_history(repo, request.history_revision.as_deref())?
        } else {
            None
        };
        let mut contents = None;
        let mut path = request.path.clone();
        let revision = if request.mode == "commit" {
            let detail = self.commit_inner(repo, request.commit.as_deref().unwrap_or_default())?;
            let file = detail
                .files
                .iter()
                .find(|file| file.path == path)
                .ok_or_else(|| Error::new("invalid", "该提交中没有这个文件。"))?;
            if before {
                path = file.old_path.clone().unwrap_or(path);
                detail
                    .commit
                    .parents
                    .first()
                    .cloned()
                    .ok_or_else(|| Error::new("missing", "该提交没有父版本。"))?
            } else {
                detail.commit.hash
            }
        } else if ["staged", "unstaged"].contains(&request.mode.as_str()) {
            self.check_line_changes(repo, request.changes_revision.as_deref())?;
            let files = self.files(repo)?;
            let file = files
                .iter()
                .find(|file| file.path == path)
                .ok_or_else(|| Error::new("changed", "该文件的比较范围已变化，请刷新差异。"))?;
            if file.conflict {
                return Err(Error::new("conflict", "冲突解决前无法确定行归属。"));
            }
            let head = self.run(repo, &["rev-parse", "--verify", "HEAD"], 256, true)?;
            if !head.ok || file.untracked || (request.mode == "staged" && file.xy.starts_with('A'))
            {
                return Ok(uncommitted(request, "尚未提交的内容"));
            }
            if request.mode == "staged" && before {
                path = file.old_path.clone().unwrap_or(path);
            } else {
                let bytes = if request.mode == "staged" || before {
                    let blob = self
                        .index_blob(repo, &path)?
                        .ok_or_else(|| Error::new("missing", "暂存区没有这个文件。"))?;
                    let output =
                        self.run_prefix(repo, &["cat-file", "blob", &blob.oid], DIFF_LIMIT + 1)?;
                    output.bytes
                } else {
                    let target = safe_file(repo, &path)?;
                    let mut bytes = vec![];
                    fs::File::open(target)?
                        .take((DIFF_LIMIT + 1) as u64)
                        .read_to_end(&mut bytes)?;
                    bytes
                };
                if bytes.len() > DIFF_LIMIT {
                    return Err(Error::new(
                        "tooLarge",
                        "工作区文件超过 240 KB 行归属读取上限。历史提交仍可按行查询。",
                    ));
                }
                if bytes.contains(&0) {
                    return Err(Error::new("binary", "此文件不能按 Git 文本行查询作者。"));
                }
                contents = Some(bytes);
                path = file.old_path.clone().unwrap_or(path);
                // Newly added index files have no ancestor to blame.
                if self.tree_blob(repo, "HEAD", &path)?.is_none() {
                    return Ok(uncommitted(request, "尚未提交的内容"));
                }
            }
            "HEAD".to_owned()
        } else {
            return Err(Error::new("invalid", "该比较范围不支持行归属。"));
        };
        let range = format!("{},{}", request.line, request.line);
        let mut args = vec![
            "-c",
            "core.quotepath=false",
            "blame",
            "--line-porcelain",
            "--no-textconv",
            "-L",
            &range,
        ];
        if contents.is_some() {
            args.extend(["--contents", "-"]);
        }
        if contents.is_none() {
            args.push(&revision);
        }
        args.extend(["--", &path]);
        let output = self.run_with_input(repo, &args, 32_000, false, contents.as_deref())?;
        if output.truncated {
            return Err(Error::new("tooLarge", "此行过长，无法完整读取作者信息。"));
        }
        let origin = parse_origin(&output.bytes, request)?;
        self.verify_expected_history_still_current(repo, history.as_deref())?;
        if request.mode != "commit" {
            self.check_line_changes(repo, request.changes_revision.as_deref())?;
        }
        Ok(origin)
    }
    fn check_line_changes(&self, repo: &Path, expected: Option<&str>) -> Result<()> {
        if let Some(expected) = expected {
            if self.snapshot(repo)?.changes_revision != expected {
                return Err(Error::new(
                    "changed",
                    "文件或暂存区已变化，请刷新差异后查看行归属。",
                ));
            }
        }
        Ok(())
    }
}
fn uncommitted(request: &LineOriginRequest, subject: &str) -> LineOrigin {
    LineOrigin {
        hash: None,
        author: "尚未提交".into(),
        email: String::new(),
        timestamp: None,
        subject: subject.into(),
        original_line: request.line,
        line: request.line,
        path: request.path.clone(),
    }
}
fn parse_origin(bytes: &[u8], request: &LineOriginRequest) -> Result<LineOrigin> {
    let text = String::from_utf8_lossy(bytes);
    let header: Vec<_> = text
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .collect();
    let hash = header
        .first()
        .ok_or_else(|| Error::new("read", "Git 行归属结果为空。"))?;
    if hash.chars().all(|c| c == '0') {
        return Ok(uncommitted(request, "此行尚未提交"));
    }
    let field = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name))
            .unwrap_or_default()
            .to_owned()
    };
    Ok(LineOrigin {
        hash: Some((*hash).into()),
        author: field("author "),
        email: field("author-mail ").trim_matches(['<', '>']).into(),
        timestamp: field("author-time ").parse().ok(),
        subject: field("summary "),
        original_line: header
            .get(1)
            .and_then(|n| n.parse().ok())
            .unwrap_or(request.line),
        line: request.line,
        path: request.path.clone(),
    })
}
