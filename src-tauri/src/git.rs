use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
mod file_preview;
pub use file_preview::FilePreview;
mod attribution;
pub use attribution::{LineOrigin, LineOriginRequest};
use std::{
    collections::HashSet,
    ffi::OsStr,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

pub const DIFF_LIMIT: usize = 240_000;
const READ_LIMIT: usize = 16_000_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(8);
static SNAPSHOT_FALLBACK_NONCE: AtomicU64 = AtomicU64::new(0);
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub kind: String,
    pub message: String,
}
impl Error {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e.to_string())
    }
}
#[derive(Clone)]
pub struct Git {
    pub binary: PathBuf,
    lfs_helper: Option<PathBuf>,
}
pub struct Output {
    pub bytes: Vec<u8>,
    pub stderr: String,
    pub ok: bool,
    pub truncated: bool,
}
fn drain(mut stream: impl Read, cap: usize) -> (Vec<u8>, bool) {
    let mut result = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 8192];
    while let Ok(n) = stream.read(&mut buffer) {
        if n == 0 {
            break;
        }
        let keep = n.min(cap.saturating_sub(result.len()));
        result.extend_from_slice(&buffer[..keep]);
        truncated |= keep < n;
    }
    (result, truncated)
}
fn should_remove_git_environment(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    if !key.starts_with("GIT_") {
        return false;
    }
    // These select the user's real global/system config sources. Keep them so
    // attributes and repository configuration match the host's Git behavior;
    // strip ephemeral config injection and all repository/helper routing.
    if matches!(
        key.as_str(),
        "GIT_CONFIG_GLOBAL" | "GIT_CONFIG_SYSTEM" | "GIT_CONFIG_NOSYSTEM"
    ) {
        return false;
    }
    true
}

fn standard_git_lfs_command(command: &str, expected_arguments: &str) -> bool {
    let command = command.trim_start();
    let (executable, remainder) = if let Some(quoted) = command.strip_prefix('\'') {
        let Some(end) = quoted.find('\'') else {
            return false;
        };
        (&quoted[..end], &quoted[end + 1..])
    } else if let Some(quoted) = command.strip_prefix('"') {
        let mut executable = String::new();
        let mut escaped = false;
        let mut end = None;
        for (index, character) in quoted.char_indices() {
            if escaped {
                executable.push(character);
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                end = Some(index + character.len_utf8());
                break;
            } else {
                executable.push(character);
            }
        }
        let Some(end) = end else {
            return false;
        };
        let remainder = &quoted[end..];
        let basename = executable.rsplit(['/', '\\']).next().unwrap_or_default();
        return matches!(
            basename.to_ascii_lowercase().as_str(),
            "git-lfs" | "git-lfs.exe"
        ) && remainder.trim() == expected_arguments;
    } else {
        let end = command.find(char::is_whitespace).unwrap_or(command.len());
        (&command[..end], &command[end..])
    };
    let basename = executable.rsplit(['/', '\\']).next().unwrap_or_default();
    matches!(
        basename.to_ascii_lowercase().as_str(),
        "git-lfs" | "git-lfs.exe"
    ) && remainder.trim() == expected_arguments
}

fn config_records(bytes: &[u8]) -> Vec<(&[u8], &[u8])> {
    bytes
        .split(|byte| *byte == 0)
        .filter_map(|record| {
            let separator = record.iter().position(|byte| *byte == b'\n')?;
            Some((&record[..separator], &record[separator + 1..]))
        })
        .collect()
}

#[cfg(unix)]
fn own_process_tree(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn own_process_tree(_command: &mut Command) {}

#[cfg(windows)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl JobHandle {
    fn create() -> std::io::Result<Self> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::JobObjects::{
                CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            return Err(error);
        }
        Ok(Self(handle))
    }

    fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe { TerminateJobObject(self.0, 1) };
    }

    fn assign_and_resume(&self, child: &Child) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                    THREADENTRY32,
                },
                JobObjects::AssignProcessToJobObject,
                Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
            },
        };

        let process = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        if unsafe { AssignProcessToJobObject(self.0, process) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            cntUsage: 0,
            th32ThreadID: 0,
            th32OwnerProcessID: 0,
            tpBasePri: 0,
            tpDeltaPri: 0,
            dwFlags: 0,
        };
        let mut thread_id = None;
        let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) } != 0;
        while has_entry {
            if entry.th32OwnerProcessID == child.id() {
                thread_id = Some(entry.th32ThreadID);
                break;
            }
            has_entry = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        let thread_id = thread_id.ok_or_else(std::io::Error::last_os_error)?;
        let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
        if thread.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let resumed = unsafe { ResumeThread(thread) } != u32::MAX;
        unsafe { CloseHandle(thread) };
        if !resumed {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        // KILL_ON_JOB_CLOSE ensures descendants that outlive Git do not remain
        // attached to this request's inherited output pipes.
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(unix)]
fn terminate_process_tree(child: &mut Child) {
    let process_group = -(child.id() as i32);
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
    let _ = child.kill();
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child, job: &JobHandle) {
    job.terminate();
    let _ = child.kill();
}

impl Git {
    pub fn new(binary: PathBuf) -> Self {
        Self {
            binary,
            lfs_helper: None,
        }
    }

    /// Tests may point the Git filter driver at a trusted helper executable.
    /// Production instances always use the current application executable.
    pub fn with_lfs_helper(binary: PathBuf, helper: PathBuf) -> Self {
        Self {
            binary,
            lfs_helper: Some(helper),
        }
    }

    fn helper_command(&self, subcommand: &str) -> Result<String> {
        let executable = match &self.lfs_helper {
            Some(path) => path.clone(),
            None => std::env::current_exe().map_err(|error| {
                Error::new("lfsHelper", format!("无法定位 LFS helper：{error}"))
            })?,
        };
        let path = executable
            .to_str()
            .ok_or_else(|| Error::new("lfsHelper", "LFS helper 路径无法安全编码。"))?
            .to_owned();
        #[cfg(windows)]
        let path = {
            // Git invokes filter commands through its shell. Forward slashes
            // keep drive paths intact inside that shell, including spaces.
            path.replace('\\', "/")
        };
        let quoted = format!("'{}'", path.replace('\'', "'\\''"));
        Ok(format!("{quoted} {subcommand}"))
    }

    fn reject_partial_clone(&self, repo: &Path) -> Result<()> {
        // GIT_NO_LAZY_FETCH is set on every child process. Refuse partial
        // clones as well so older Git versions that ignore that variable can
        // never turn a read into a network fetch or an object-store write.
        let config = self.run(repo, &["config", "--null", "--list"], READ_LIMIT, true)?;
        if config.truncated {
            return Err(Error::new(
                "tooLarge",
                "Git 配置过大，无法确认是否为部分克隆仓库。",
            ));
        }
        let is_partial = config_records(&config.bytes)
            .into_iter()
            .any(|(key, value)| {
                let key = String::from_utf8_lossy(key).to_ascii_lowercase();
                let value = String::from_utf8_lossy(value).trim().to_ascii_lowercase();
                key == "extensions.partialclone"
                    || (key.starts_with("remote.")
                        && key.ends_with(".promisor")
                        && !matches!(value.as_str(), "false" | "no" | "off" | "0"))
            });
        if is_partial {
            return Err(Error::new(
                "partialCloneUnsupported",
                "只读模式暂不支持部分克隆仓库，避免按需下载 Git 对象。",
            ));
        }
        Ok(())
    }

    pub fn run(
        &self,
        repo: &Path,
        args: &[&str],
        cap: usize,
        allow_failure: bool,
    ) -> Result<Output> {
        self.run_with_input(repo, args, cap, allow_failure, None)
    }

    fn run_with_input(
        &self,
        repo: &Path,
        args: &[&str],
        cap: usize,
        allow_failure: bool,
        input: Option<&[u8]>,
    ) -> Result<Output> {
        self.run_with_options(repo, args, cap, allow_failure, input, false)
    }
    fn run_prefix(&self, repo: &Path, args: &[&str], cap: usize) -> Result<Output> {
        self.run_with_options(repo, args, cap, true, None, true)
    }
    fn run_with_options(
        &self,
        repo: &Path,
        args: &[&str],
        cap: usize,
        allow_failure: bool,
        input: Option<&[u8]>,
        prefix_only: bool,
    ) -> Result<Output> {
        let process_command = self.helper_command(crate::lfs::FILTER_PROCESS_COMMAND)?;
        let clean_command = self.helper_command(crate::lfs::CLEAN_COMMAND)?;
        let mut command = Command::new(&self.binary);
        for (key, _) in std::env::vars_os().filter(|(key, _)| should_remove_git_environment(key)) {
            command.env_remove(key);
        }
        command
            .args([
                "--no-pager",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "log.showSignature=false",
                "-c",
                "diff.autoRefreshIndex=false",
                "-c",
                "filter.lfs.required=true",
                "-c",
            ])
            .arg(format!("filter.lfs.process={process_command}"))
            .arg("-c")
            .arg(format!("filter.lfs.clean={clean_command}"))
            .args(["-C"])
            .arg(repo)
            .args(args)
            // A Git invocation always belongs to the selected repository. Do
            // not inherit routing, alternate-index/object, namespace, or
            // one-off config overrides from a host app or shell.
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            });
        own_process_tree(&mut command);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
            // Suspend Git until its process is assigned to a kill-on-close Job.
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        }
        #[cfg(windows)]
        let job = JobHandle::create()
            .map_err(|e| Error::new("process", format!("无法管理 Git 子进程：{e}")))?;
        let deadline = Instant::now() + GIT_TIMEOUT;
        let mut child = command
            .spawn()
            .map_err(|e| Error::new("gitUnavailable", format!("无法启动 Git：{e}")))?;
        #[cfg(windows)]
        if let Err(error) = job.assign_and_resume(&child) {
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::new(
                "process",
                format!("无法安全管理 Git 子进程：{error}"),
            ));
        }
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let out = thread::spawn(move || -> std::io::Result<(Vec<u8>, bool)> {
            if prefix_only {
                let mut bytes = Vec::new();
                stdout.take((cap + 1) as u64).read_to_end(&mut bytes)?;
                let truncated = bytes.len() > cap;
                bytes.truncate(cap);
                Ok((bytes, truncated))
            } else {
                Ok(drain(stdout, cap))
            }
        });
        let err = thread::spawn(move || drain(stderr, 32_000));
        let input_writer = input.map(|input| {
            let mut stdin = child.stdin.take().unwrap();
            let input = input.to_vec();
            thread::spawn(move || stdin.write_all(&input))
        });
        // The request deadline covers Git, helper descendants, and every pipe
        // reader/writer. No blocking join starts until all have completed or the
        // request-owned process group / Windows Job has been terminated.
        let mut status: Option<ExitStatus> = None;
        let mut wait_error = None;
        let timed_out = loop {
            if status.is_none() {
                match child.try_wait() {
                    Ok(Some(value)) => status = Some(value),
                    Ok(None) => {}
                    Err(error) => {
                        wait_error = Some(error);
                        #[cfg(unix)]
                        terminate_process_tree(&mut child);
                        #[cfg(windows)]
                        terminate_process_tree(&mut child, &job);
                        let _ = child.wait();
                        break false;
                    }
                }
            }
            if Instant::now() >= deadline {
                #[cfg(unix)]
                terminate_process_tree(&mut child);
                #[cfg(windows)]
                terminate_process_tree(&mut child, &job);
                if status.is_none() {
                    status = child.wait().ok();
                }
                break true;
            }
            let readers_done = out.is_finished()
                && err.is_finished()
                && input_writer
                    .as_ref()
                    .is_none_or(thread::JoinHandle::is_finished);
            if status.is_some() && readers_done {
                break false;
            }
            thread::sleep(Duration::from_millis(5));
        };
        let (bytes, truncated) = out
            .join()
            .map_err(|_| Error::new("read", "Git 输出读取失败"))??;
        let (stderr, _) = err
            .join()
            .map_err(|_| Error::new("read", "Git 错误读取失败"))?;
        if let Some(writer) = input_writer {
            writer
                .join()
                .map_err(|_| Error::new("read", "Git 输入写入失败"))?
                .map_err(|error| Error::new("read", format!("Git 输入写入失败：{error}")))?;
        }
        let stderr = String::from_utf8_lossy(&stderr).trim().to_owned();
        if let Some(error) = wait_error {
            return Err(error.into());
        }
        if timed_out {
            let message = if cfg!(target_os = "macos") {
                "Git 读取超时。如果 macOS 正在询问文件访问权限，请处理后重试。"
            } else {
                "Git 读取超时，请稍后重试。"
            };
            return Err(Error::new("timeout", message));
        }
        let status = status.ok_or_else(|| Error::new("process", "Git 子进程状态读取失败。"))?;
        if !status.success() && !allow_failure {
            return Err(Error::new(
                "git",
                if stderr.is_empty() {
                    "Git 读取失败".into()
                } else {
                    stderr
                },
            ));
        }
        Ok(Output {
            bytes,
            stderr,
            ok: status.success(),
            truncated,
        })
    }
    pub fn text(&self, repo: &Path, args: &[&str], allow_failure: bool) -> Result<String> {
        let out = self.run(repo, args, READ_LIMIT, allow_failure)?;
        if out.truncated {
            return Err(Error::new("tooLarge", "仓库输出过大，无法完整读取。"));
        }
        Ok(String::from_utf8_lossy(&out.bytes)
            .trim_end_matches(['\r', '\n'])
            .to_owned())
    }
    pub fn discover() -> Result<(Self, String)> {
        let mut candidates = Vec::new();
        #[cfg(target_os = "macos")]
        candidates.extend(
            [
                "/opt/homebrew/bin/git",
                "/usr/local/bin/git",
                "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
                "/Library/Developer/CommandLineTools/usr/bin/git",
                "/usr/bin/git",
            ]
            .map(PathBuf::from),
        );
        candidates.push(PathBuf::from("git"));
        #[cfg(windows)]
        for (variable, suffix) in [
            ("ProgramFiles", "Git/cmd/git.exe"),
            ("LOCALAPPDATA", "Programs/Git/cmd/git.exe"),
        ] {
            if let Some(base) = std::env::var_os(variable) {
                candidates.push(PathBuf::from(base).join(suffix));
            }
        }
        for binary in candidates {
            let git = Self::new(binary);
            if let Ok(version) = git.text(&std::env::temp_dir(), &["--version"], false) {
                return Ok((git, version));
            }
        }
        Err(Error::new(
            "gitMissing",
            "没有找到可用的 Git。安装 Git 后，点击重新检测。",
        ))
    }
    pub fn normalize(&self, path: &Path) -> Result<PathBuf> {
        let path = dunce::canonicalize(path)
            .map_err(|_| Error::new("missing", "这个项目目录不存在或无法访问。"))?;
        if self.text(&path, &["rev-parse", "--is-bare-repository"], true)? == "true" {
            return Err(Error::new(
                "bare",
                "第一版暂不支持裸仓库，请选择带工作目录的 Git 项目。",
            ));
        }
        let root = self.repository_root(&path)?;
        self.reject_partial_clone(&root)?;
        Ok(root)
    }
    fn repository_root(&self, path: &Path) -> Result<PathBuf> {
        let root = self.run(path, &["rev-parse", "--show-toplevel"], READ_LIMIT, true)?;
        if !root.ok {
            return Err(Error::new(
                "notRepository",
                "这个文件夹尚未初始化 Git。请在编辑器或终端中初始化后重新打开。",
            ));
        }
        Ok(dunce::canonicalize(
            String::from_utf8_lossy(&root.bytes).trim_end_matches(['\r', '\n']),
        )?)
    }
    pub fn git_path(&self, repo: &Path, name: &str) -> Result<PathBuf> {
        let path = PathBuf::from(self.text(repo, &["rev-parse", "--git-path", name], false)?);
        Ok(if path.is_absolute() {
            path
        } else {
            repo.join(path)
        })
    }
    fn git_paths(&self, repo: &Path, names: &[&str]) -> Result<Vec<PathBuf>> {
        let mut args = Vec::with_capacity(names.len() * 2 + 1);
        args.push("rev-parse");
        for name in names {
            args.push("--git-path");
            args.push(name);
        }
        let raw = self.text(repo, &args, false)?;
        let paths: Vec<_> = raw
            .lines()
            .map(|value| {
                let path = PathBuf::from(value);
                if path.is_absolute() {
                    path
                } else {
                    repo.join(path)
                }
            })
            .collect();
        if paths.len() != names.len() {
            return Err(Error::new("read", "Git 元数据路径读取失败。"));
        }
        Ok(paths)
    }
    fn reference_state(&self, repo: &Path) -> Result<(Vec<Reference>, String)> {
        let raw = self.text(
            repo,
            &[
                "for-each-ref",
                "--format=%(refname)%00%(objectname)%00%(*objectname)",
                "refs/heads",
                "refs/remotes",
                "refs/tags",
                "refs/replace",
            ],
            false,
        )?;
        let mut refs = Vec::new();
        let mut replace_refs = String::new();
        for line in raw.lines() {
            let parts: Vec<_> = line.split('\0').collect();
            if parts.len() != 3 {
                continue;
            }
            let full_name = parts[0].to_owned();
            if full_name.starts_with("refs/replace/") {
                replace_refs.push_str(parts[0]);
                replace_refs.push('\0');
                replace_refs.push_str(parts[1]);
                replace_refs.push('\n');
                continue;
            }
            let kind = if full_name.starts_with("refs/heads/") {
                "branch"
            } else if full_name.starts_with("refs/remotes/") {
                "remote"
            } else {
                "tag"
            };
            refs.push(Reference {
                name: full_name.splitn(3, '/').nth(2).unwrap_or(&full_name).into(),
                full_name,
                hash: if parts[2].is_empty() {
                    parts[1]
                } else {
                    parts[2]
                }
                .into(),
                kind: kind.into(),
            });
        }
        Ok((refs, replace_refs))
    }
    pub fn refs(&self, repo: &Path) -> Result<Vec<Reference>> {
        self.reference_state(repo).map(|(refs, _)| refs)
    }
    fn history_context(&self, repo: &Path, replace_refs: &str) -> Result<String> {
        // Keep replacement refs out of the visible branch/tag list while still
        // making changes to them invalidate the parsed commit graph.
        let replace_setting = self.text(
            repo,
            &["config", "--bool", "--get", "core.useReplaceRefs"],
            true,
        )?;
        let mut digest = Sha256::new();
        digest.update(b"replace-refs\0");
        digest.update(replace_refs.as_bytes());
        digest.update(b"replace-setting\0");
        digest.update(if replace_setting.is_empty() {
            b"default-enabled".as_slice()
        } else {
            replace_setting.as_bytes()
        });
        let paths = self.git_paths(repo, &["shallow", "info/grafts"])?;
        for (marker, path) in ["shallow", "info/grafts"].iter().zip(paths) {
            digest.update(marker.as_bytes());
            add_history_file_state(&mut digest, &path)?;
        }
        Ok(format!("{:x}", digest.finalize()))
    }
    fn history_state(&self, repo: &Path) -> Result<(String, Vec<Reference>, String)> {
        let head = self.text(repo, &["rev-parse", "--verify", "HEAD"], true)?;
        let (refs, replace_refs) = self.reference_state(repo)?;
        let context = self.history_context(repo, &replace_refs)?;
        let revision = history_id(&head, &refs, &context);
        Ok((head, refs, revision))
    }
    fn history_revision(&self, repo: &Path) -> Result<String> {
        self.history_state(repo).map(|(_, _, revision)| revision)
    }
    fn check_expected_history(
        &self,
        repo: &Path,
        expected: Option<&str>,
    ) -> Result<Option<String>> {
        let Some(expected) = expected.filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let actual = self.history_revision(repo)?;
        if actual != expected {
            return Err(Error::new("staleHistory", "提交历史已变化，正在重新加载。"));
        }
        Ok(Some(actual))
    }
    fn verify_expected_history_still_current(
        &self,
        repo: &Path,
        expected: Option<&str>,
    ) -> Result<()> {
        if let Some(expected) = expected {
            let actual = self.history_revision(repo)?;
            if actual != expected {
                return Err(Error::new("staleHistory", "提交历史已变化，正在重新加载。"));
            }
        }
        Ok(())
    }
    fn tracked_index_entries(&self, repo: &Path) -> Result<Vec<IndexEntry>> {
        let index = self.run(repo, &["ls-files", "--stage", "-z"], READ_LIMIT, false)?;
        if index.truncated {
            return Err(Error::new("tooLarge", "暂存区过大，无法完整读取。"));
        }
        Ok(index
            .bytes
            .split(|byte| *byte == 0)
            .filter_map(|record| {
                let separator = record.iter().position(|byte| *byte == b'\t')?;
                let header = &record[..separator];
                let mut fields = header.split(|byte| *byte == b' ');
                Some(IndexEntry {
                    mode: fields.next()?.to_vec(),
                    oid: fields.next()?.to_vec(),
                    path: record[separator + 1..].to_vec(),
                })
            })
            .collect())
    }
    fn reject_active_filters(&self, repo: &Path) -> Result<()> {
        let mut visited = HashSet::new();
        self.reject_active_filters_inner(repo, &mut visited, 0)
    }
    fn reject_active_filters_inner(
        &self,
        repo: &Path,
        visited: &mut HashSet<PathBuf>,
        depth: usize,
    ) -> Result<()> {
        if depth > 32 || visited.len() > 2048 {
            return Err(Error::new(
                "tooLarge",
                "子模块层级过深，无法安全检查 Git 过滤器。",
            ));
        }
        let canonical_repo = dunce::canonicalize(repo)?;
        if !visited.insert(canonical_repo.clone()) {
            return Ok(());
        }
        self.reject_partial_clone(&canonical_repo)?;
        let entries = self.tracked_index_entries(&canonical_repo)?;
        let mut paths = Vec::new();
        let mut gitlinks = Vec::new();
        for entry in &entries {
            paths.push(entry.path.clone());
            if entry.mode == b"160000" {
                gitlinks.push(entry.path.clone());
            }
        }
        if !paths.is_empty() {
            let mut input = Vec::new();
            for path in paths {
                input.extend_from_slice(&path);
                input.push(0);
            }
            let attributes = self.run_with_input(
                &canonical_repo,
                &["check-attr", "-z", "--stdin", "filter"],
                READ_LIMIT,
                false,
                Some(&input),
            )?;
            if attributes.truncated {
                return Err(Error::new(
                    "tooLarge",
                    "Git 属性检查结果过大，无法确认只读安全。",
                ));
            }
            let fields: Vec<_> = attributes.bytes.split(|byte| *byte == 0).collect();
            let mut drivers = HashSet::<String>::new();
            let mut lfs_paths = HashSet::<Vec<u8>>::new();
            for record in fields.as_chunks::<3>().0 {
                if record[1] != b"filter" || matches!(record[2], b"unspecified" | b"unset") {
                    continue;
                }
                let name = std::str::from_utf8(record[2]).map_err(|_| {
                    Error::new(
                        "unsafeFilter",
                        "此仓库配置了无法识别的 Git 内容过滤器，无法只读查看。",
                    )
                })?;
                drivers.insert(name.to_owned());
                if name == "lfs" {
                    lfs_paths.insert(record[0].to_vec());
                }
            }
            if drivers.contains("lfs") {
                self.validate_standard_lfs_driver(&canonical_repo)?;
                self.reject_lfs_index_extensions(&canonical_repo, &entries, &lfs_paths)?;
            }
            let mut active = HashSet::<String>::new();
            for name in drivers {
                if name == "lfs" {
                    continue;
                }
                for operation in ["clean", "process"] {
                    let key = format!("filter.{name}.{operation}");
                    let configured = self.run(
                        &canonical_repo,
                        &["config", "--null", "--get", &key],
                        32_000,
                        true,
                    )?;
                    let command = configured
                        .bytes
                        .split(|byte| *byte == 0)
                        .next()
                        .unwrap_or_default();
                    if configured.ok && command.iter().any(|byte| !byte.is_ascii_whitespace()) {
                        active.insert(name.clone());
                    }
                }
            }
            if !active.is_empty() {
                let mut names: Vec<_> = active.into_iter().collect();
                names.sort();
                return Err(Error::new(
                    "unsafeFilter",
                    format!(
                        "此仓库启用了可能写入文件的 Git clean/process 过滤器（{}），无法在只读模式下查看。",
                        names.join("、")
                    ),
                ));
            }
        }
        for path in gitlinks {
            let child = path_from_git_bytes(&path);
            if child.is_absolute()
                || child
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            {
                return Err(Error::new("unsafePath", "子模块路径超出仓库范围。"));
            }
            let candidate = canonical_repo.join(child);
            let Ok(metadata) = fs::symlink_metadata(&candidate) else {
                continue;
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let Ok(candidate_root) = dunce::canonicalize(&candidate) else {
                continue;
            };
            if !candidate_root.starts_with(&canonical_repo) {
                return Err(Error::new("unsafePath", "子模块路径超出仓库范围。"));
            }
            let root = self.run(
                &candidate_root,
                &["rev-parse", "--show-toplevel"],
                READ_LIMIT,
                true,
            )?;
            if !root.ok {
                continue;
            }
            let root = dunce::canonicalize(
                String::from_utf8_lossy(&root.bytes).trim_end_matches(['\r', '\n']),
            )?;
            if root == candidate_root {
                self.reject_active_filters_inner(&root, visited, depth + 1)?;
            }
        }
        Ok(())
    }
    fn reject_lfs_index_extensions(
        &self,
        repo: &Path,
        entries: &[IndexEntry],
        lfs_paths: &HashSet<Vec<u8>>,
    ) -> Result<()> {
        let mut seen = HashSet::<Vec<u8>>::new();
        let mut object_ids = Vec::new();
        for entry in entries {
            if entry.mode.starts_with(b"100")
                && lfs_paths.contains(&entry.path)
                && seen.insert(entry.oid.clone())
            {
                object_ids.push(entry.oid.clone());
            }
        }
        const BATCH_SIZE: usize = 512;
        for objects in object_ids.chunks(BATCH_SIZE) {
            let mut input = Vec::with_capacity(objects.len() * 42);
            for oid in objects {
                input.extend_from_slice(oid);
                input.push(b'\n');
            }
            let checked = self.run_with_input(
                repo,
                &[
                    "cat-file",
                    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                ],
                READ_LIMIT,
                false,
                Some(&input),
            )?;
            if checked.truncated {
                return Err(Error::new(
                    "tooLarge",
                    "暂存区 LFS 对象信息过大，无法确认指针安全。",
                ));
            }
            let mut small = Vec::new();
            for (oid, line) in objects
                .iter()
                .zip(checked.bytes.split(|byte| *byte == b'\n'))
            {
                if line.is_empty() {
                    continue;
                }
                let fields: Vec<_> = line.split(|byte| byte.is_ascii_whitespace()).collect();
                if fields.get(1) != Some(&b"blob".as_slice()) {
                    continue;
                }
                let Some(size) = fields
                    .get(2)
                    .and_then(|value| std::str::from_utf8(value).ok())
                    .and_then(|value| value.parse::<usize>().ok())
                else {
                    continue;
                };
                if size < 1024 {
                    small.push((oid.clone(), size));
                }
            }
            for batch in small.chunks(BATCH_SIZE) {
                let mut input = Vec::with_capacity(batch.len() * 42);
                for (oid, _) in batch {
                    input.extend_from_slice(oid);
                    input.push(b'\n');
                }
                let output = self.run_with_input(
                    repo,
                    &["cat-file", "--batch"],
                    1024 * 1024,
                    false,
                    Some(&input),
                )?;
                if output.truncated {
                    return Err(Error::new("tooLarge", "暂存区 LFS 指针读取结果过大。"));
                }
                let mut offset = 0_usize;
                for (expected_oid, expected_size) in batch {
                    let header_end = output.bytes[offset..]
                        .iter()
                        .position(|byte| *byte == b'\n')
                        .map(|length| offset + length)
                        .ok_or_else(|| Error::new("read", "Git LFS 指针对象头不完整。"))?;
                    let fields: Vec<_> = output.bytes[offset..header_end]
                        .split(|byte| byte.is_ascii_whitespace())
                        .collect();
                    if fields.first().copied() != Some(expected_oid.as_slice())
                        || fields.get(1) != Some(&b"blob".as_slice())
                        || fields.get(2).and_then(|value| {
                            std::str::from_utf8(value).ok()?.parse::<usize>().ok()
                        }) != Some(*expected_size)
                    {
                        return Err(Error::new("read", "Git LFS 指针对象头无效。"));
                    }
                    offset = header_end + 1;
                    let end = offset
                        .checked_add(*expected_size)
                        .ok_or_else(|| Error::new("read", "Git LFS 指针对象长度无效。"))?;
                    let bytes = output
                        .bytes
                        .get(offset..end)
                        .ok_or_else(|| Error::new("read", "Git LFS 指针对象不完整。"))?;
                    if crate::lfs::has_unsupported_extension(bytes) {
                        return Err(Error::new(
                            "unsupportedLfsExtension",
                            "暂不支持含 Git LFS 扩展字段的指针文件。",
                        ));
                    }
                    offset = end;
                    if output.bytes.get(offset) != Some(&b'\n') {
                        return Err(Error::new("read", "Git LFS 指针对象边界无效。"));
                    }
                    offset += 1;
                }
            }
        }
        Ok(())
    }
    fn external_config_values(&self, repo: &Path, key: &str) -> Result<Vec<String>> {
        let output = self.run(
            repo,
            &["config", "--null", "--show-origin", "--get-all", key],
            32_000,
            true,
        )?;
        if output.truncated {
            return Err(Error::new(
                "tooLarge",
                "Git LFS 过滤器配置过大，无法确认只读安全。",
            ));
        }
        let fields: Vec<_> = output.bytes.split(|byte| *byte == 0).collect();
        Ok(fields
            .as_chunks::<2>()
            .0
            .iter()
            .filter(|pair| pair[0] != b"command line:")
            .map(|pair| String::from_utf8_lossy(pair[1]).into_owned())
            .collect())
    }
    fn validate_standard_lfs_driver(&self, repo: &Path) -> Result<()> {
        for (operation, arguments) in [
            ("process", "filter-process"),
            ("clean", "clean -- %f"),
            ("smudge", "smudge -- %f"),
        ] {
            let key = format!("filter.lfs.{operation}");
            let values = self.external_config_values(repo, &key)?;
            let Some(command) = values.last().map(String::as_str) else {
                continue;
            };
            if command.trim().is_empty() || standard_git_lfs_command(command, arguments) {
                continue;
            }
            return Err(Error::new(
                "unsafeFilter",
                format!(
                    "此仓库的 filter.lfs.{operation} 不是标准 Git LFS 命令，无法确认只读语义。"
                ),
            ));
        }
        let extensions = self.run(repo, &["config", "--null", "--list"], READ_LIMIT, true)?;
        if extensions.truncated {
            return Err(Error::new(
                "tooLarge",
                "Git LFS 扩展配置过大，无法确认只读安全。",
            ));
        }
        if config_records(&extensions.bytes).iter().any(|(key, _)| {
            String::from_utf8_lossy(key)
                .to_ascii_lowercase()
                .starts_with("lfs.extension.")
        }) {
            return Err(Error::new(
                "unsupportedLfsExtension",
                "此仓库配置了 Git LFS 扩展转换，当前只支持标准 LFS 指针。",
            ));
        }
        Ok(())
    }
    fn path_uses_lfs(
        &self,
        repo: &Path,
        path: &str,
        source: Option<&str>,
        cached: bool,
    ) -> Result<bool> {
        validate_relative(path)?;
        let mut args = vec!["check-attr"];
        if let Some(source) = source {
            args.extend(["--source", source]);
        } else if cached {
            args.push("--cached");
        }
        args.extend(["-z", "--stdin", "filter"]);
        let input = [path.as_bytes(), b"\0"].concat();
        let output = self.run_with_input(repo, &args, 4096, source.is_some(), Some(&input))?;
        if !output.ok {
            if source.is_some()
                && (output.stderr.contains("unknown option")
                    || output.stderr.contains("unknown argument"))
            {
                return Err(Error::new(
                    "lfsAttributeSourceUnsupported",
                    "此版本 Git 无法读取提交当时的 .gitattributes，未确认该历史差异的 LFS 状态。",
                ));
            }
            return Err(Error::new("git", output.stderr));
        }
        if output.truncated {
            return Err(Error::new(
                "tooLarge",
                "Git 属性检查结果过大，无法确认 LFS 状态。",
            ));
        }
        let fields: Vec<_> = output.bytes.split(|byte| *byte == 0).collect();
        let is_lfs = fields
            .as_chunks::<3>()
            .0
            .iter()
            .any(|record| record[1] == b"filter" && record[2] == b"lfs");
        if is_lfs {
            self.validate_standard_lfs_driver(repo)?;
        }
        Ok(is_lfs)
    }
    fn index_blob(&self, repo: &Path, path: &str) -> Result<Option<GitBlob>> {
        self.index_stage_blob(repo, path, "0")
    }
    fn index_stage_blob(&self, repo: &Path, path: &str, stage: &str) -> Result<Option<GitBlob>> {
        let literal = format!(":(literal){path}");
        let output = self.run(
            repo,
            &["ls-files", "--stage", "-z", "--", &literal],
            4096,
            false,
        )?;
        if output.truncated {
            return Err(Error::new("tooLarge", "选中文件的暂存信息过大。"));
        }
        Ok(output
            .bytes
            .split(|byte| *byte == 0)
            .filter_map(parse_index_blob_record)
            .find(|entry| entry.stage == stage))
    }
    fn tree_blob(&self, repo: &Path, revision: &str, path: &str) -> Result<Option<GitBlob>> {
        let literal = format!(":(literal){path}");
        let output = self.run(
            repo,
            &["ls-tree", "-r", "-z", revision, "--", &literal],
            4096,
            false,
        )?;
        if output.truncated {
            return Err(Error::new("tooLarge", "选中文件的历史信息过大。"));
        }
        Ok(output
            .bytes
            .split(|byte| *byte == 0)
            .filter_map(parse_tree_blob_record)
            .next())
    }
    fn small_blob(&self, repo: &Path, oid: &str) -> Result<Option<Vec<u8>>> {
        let input = [oid.as_bytes(), b"\n"].concat();
        let checked = self.run_with_input(
            repo,
            &[
                "cat-file",
                "--batch-check=%(objectname) %(objecttype) %(objectsize)",
            ],
            256,
            false,
            Some(&input),
        )?;
        let fields: Vec<_> = checked
            .bytes
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|field| !field.is_empty())
            .collect();
        if fields.get(1).copied() != Some(b"blob".as_slice()) {
            return Ok(None);
        }
        let Some(size) = fields
            .get(2)
            .and_then(|value| std::str::from_utf8(value).ok())
            .and_then(|value| value.parse::<usize>().ok())
        else {
            return Ok(None);
        };
        if size >= 1024 {
            return Ok(None);
        }
        let output =
            self.run_with_input(repo, &["cat-file", "--batch"], 2048, false, Some(&input))?;
        let header_end = output
            .bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| Error::new("read", "Git LFS 指针对象头不完整。"))?;
        let header: Vec<_> = output.bytes[..header_end]
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|field| !field.is_empty())
            .collect();
        let returned_oid = std::str::from_utf8(header.first().copied().unwrap_or_default())
            .map_err(|_| Error::new("read", "Git LFS 指针对象 ID 无效。"))?;
        if returned_oid != oid
            || header.get(1).copied() != Some(b"blob".as_slice())
            || header
                .get(2)
                .and_then(|value| std::str::from_utf8(value).ok()?.parse::<usize>().ok())
                != Some(size)
        {
            return Err(Error::new("read", "Git LFS 指针对象头无效。"));
        }
        let start = header_end + 1;
        let end = start
            .checked_add(size)
            .ok_or_else(|| Error::new("read", "Git LFS 指针对象长度无效。"))?;
        let body = output
            .bytes
            .get(start..end)
            .ok_or_else(|| Error::new("read", "Git LFS 指针对象不完整。"))?;
        if output.bytes.get(end) != Some(&b'\n') {
            return Err(Error::new("read", "Git LFS 指针对象边界无效。"));
        }
        Ok(Some(body.to_vec()))
    }
    fn lfs_side_from_blob(
        &self,
        repo: &Path,
        blob: Option<GitBlob>,
        filter_lfs: bool,
    ) -> Result<LfsSide> {
        let Some(blob) = blob else {
            return Ok(LfsSide::missing());
        };
        if !filter_lfs {
            return Ok(LfsSide::regular());
        }
        if !blob.mode.starts_with("100") {
            return Ok(LfsSide::unsupported());
        }
        let Some(bytes) = self.small_blob(repo, &blob.oid)? else {
            return Ok(LfsSide::regular());
        };
        if crate::lfs::has_unsupported_extension(&bytes) {
            return Err(Error::new(
                "unsupportedLfsExtension",
                "暂不支持含 Git LFS 扩展字段的指针文件。",
            ));
        }
        Ok(crate::lfs::parse_pointer(&bytes)
            .map(LfsPointer::from)
            .map_or_else(LfsSide::regular, LfsSide::pointer))
    }
    fn lfs_side_from_worktree(&self, repo: &Path, path: &str, filter_lfs: bool) -> Result<LfsSide> {
        let target = match safe_file(repo, path) {
            Ok(target) => target,
            Err(error) if error.kind == "symlink" => return Ok(LfsSide::unsupported()),
            Err(error) if error.kind == "missing" => return Ok(LfsSide::missing()),
            Err(error) => return Err(error),
        };
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LfsSide::missing());
            }
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() {
            return Ok(LfsSide::unsupported());
        }
        if !filter_lfs {
            return Ok(LfsSide::regular());
        }
        let file = fs::File::open(target)?;
        let mut clean = Vec::with_capacity(1024);
        let pointer = crate::lfs::clean(&mut &file, &mut clean).map_err(|error| match error {
            crate::lfs::CleanError::UnsupportedExtension => Error::new(
                "unsupportedLfsExtension",
                "暂不支持含 Git LFS 扩展字段的指针文件。",
            ),
            crate::lfs::CleanError::Io(error) => error.into(),
        })?;
        Ok(pointer
            .map(LfsPointer::from)
            .map_or_else(LfsSide::regular, LfsSide::pointer))
    }
    fn workspace_lfs_diff(
        &self,
        repo: &Path,
        mode: &str,
        file: &FileState,
    ) -> Result<Option<LfsDiff>> {
        if file.conflict || mode == "conflict" {
            return Ok(None);
        }
        let path = file.path.as_str();
        let old_path = file.old_path.as_deref().unwrap_or(path);
        let (before_path, before_cached, after_path, after_cached, before_revision) =
            if mode == "staged" {
                (old_path, false, path, true, Some("HEAD"))
            } else {
                (path, true, path, false, None)
            };
        let has_head = self
            .run(repo, &["rev-parse", "--verify", "HEAD"], 256, true)?
            .ok;
        let before_lfs = if let Some(revision) = before_revision.filter(|_| has_head) {
            self.path_uses_lfs(repo, before_path, Some(revision), false)?
        } else {
            self.path_uses_lfs(repo, before_path, None, before_cached)?
        };
        let after_lfs = self.path_uses_lfs(repo, after_path, None, after_cached)?;
        if !before_lfs && !after_lfs {
            return Ok(None);
        }
        let before_blob = if mode == "staged" && has_head {
            self.tree_blob(repo, "HEAD", before_path)?
        } else if mode == "staged" {
            None
        } else {
            self.index_blob(repo, before_path)?
        };
        let before = self.lfs_side_from_blob(repo, before_blob, before_lfs)?;
        let after = if mode == "staged" {
            self.lfs_side_from_blob(repo, self.index_blob(repo, after_path)?, after_lfs)?
        } else {
            self.lfs_side_from_worktree(repo, after_path, after_lfs)?
        };
        Ok(Some(LfsDiff::from_sides(before, after)))
    }
    fn conflict_lfs_diff(&self, repo: &Path, path: &str) -> Result<Option<LfsDiff>> {
        let current_attrs = self.path_uses_lfs(repo, path, None, false)?;
        let index_attrs = self.path_uses_lfs(repo, path, None, true)?;
        if !current_attrs && !index_attrs {
            return Ok(None);
        }
        let ours = self.index_stage_blob(repo, path, "2")?;
        let theirs = self.index_stage_blob(repo, path, "3")?;
        let mut lfs = LfsDiff::from_sides(
            self.lfs_side_from_blob(repo, ours, true)?,
            self.lfs_side_from_blob(repo, theirs, true)?,
        );
        lfs.conflict = Some(true);
        Ok(Some(lfs))
    }
    fn commit_lfs_diff(
        &self,
        repo: &Path,
        revision: &str,
        parent: Option<&str>,
        old_path: Option<&str>,
        path: &str,
    ) -> Result<Option<LfsDiff>> {
        let before_path = old_path.unwrap_or(path);
        let before_lfs = match parent {
            Some(parent) => self.path_uses_lfs(repo, before_path, Some(parent), false)?,
            None => false,
        };
        let after_lfs = self.path_uses_lfs(repo, path, Some(revision), false)?;
        if !before_lfs && !after_lfs {
            return Ok(None);
        }
        let before_blob = match parent {
            Some(parent) => self.tree_blob(repo, parent, before_path)?,
            None => None,
        };
        let after_blob = self.tree_blob(repo, revision, path)?;
        let before = self.lfs_side_from_blob(repo, before_blob, before_lfs)?;
        let after = self.lfs_side_from_blob(repo, after_blob, after_lfs)?;
        Ok(Some(LfsDiff::from_sides(before, after)))
    }
    pub fn files(&self, repo: &Path) -> Result<Vec<FileState>> {
        self.reject_partial_clone(repo)?;
        self.files_with_status_revision(repo)
            .map(|(files, _)| files)
    }
    fn files_with_status_revision(&self, repo: &Path) -> Result<(Vec<FileState>, [u8; 32])> {
        // `status` can invoke an active clean/process conversion driver while
        // comparing tracked worktree bytes. Verify effective attributes first;
        // an unused global filter config remains harmless.
        self.reject_active_filters(repo)?;
        let raw = self.run(
            repo,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            READ_LIMIT,
            false,
        )?;
        if raw.truncated {
            return Err(Error::new("tooLarge", "变更文件过多，无法完整读取。"));
        }
        let status_revision: [u8; 32] = Sha256::digest(&raw.bytes).into();
        let entries: Vec<_> = raw.bytes.split(|b| *b == 0).collect();
        let mut files = Vec::new();
        let mut i = 0;
        while i < entries.len() {
            let entry = entries[i];
            i += 1;
            if entry.len() < 3 {
                continue;
            }
            let xy = String::from_utf8_lossy(&entry[..2]).into_owned();
            let path = String::from_utf8_lossy(&entry[3..]).into_owned();
            let old_path = if xy.contains('R') || xy.contains('C') {
                let old = entries
                    .get(i)
                    .map(|e| String::from_utf8_lossy(e).into_owned());
                i += 1;
                old
            } else {
                None
            };
            let conflict = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].contains(&xy.as_str());
            let untracked = xy == "??";
            files.push(FileState {
                path,
                old_path,
                staged: !conflict && !b" ?!".contains(&entry[0]),
                unstaged: !conflict && !b" ?!".contains(&entry[1]),
                conflict,
                untracked,
                xy,
            });
        }
        Ok((files, status_revision))
    }
    fn index_revision(&self, repo: &Path, fallback_nonce: u64) -> Result<[u8; 32]> {
        let mut visited = HashSet::new();
        self.index_revision_inner(repo, fallback_nonce, &mut visited, 0)
    }
    fn index_revision_inner(
        &self,
        repo: &Path,
        fallback_nonce: u64,
        visited: &mut HashSet<PathBuf>,
        depth: usize,
    ) -> Result<[u8; 32]> {
        if depth > 32 || visited.len() > 2048 {
            return Err(Error::new(
                "tooLarge",
                "子模块层级过深，无法安全校验工作区版本。",
            ));
        }
        let canonical_repo = dunce::canonicalize(repo)?;
        if !visited.insert(canonical_repo.clone()) {
            let mut digest = Sha256::new();
            digest.update(b"repeated-submodule-root\0");
            digest.update(canonical_repo.to_string_lossy().as_bytes());
            return Ok(digest.finalize().into());
        }
        let index = self.run(repo, &["ls-files", "--stage", "-z"], READ_LIMIT, false)?;
        if index.truncated {
            return Err(Error::new("tooLarge", "暂存区过大，无法完整读取。"));
        }
        let mut digest = Sha256::new();
        digest.update(&index.bytes);
        for record in index.bytes.split(|byte| *byte == 0) {
            let Some(separator) = record.iter().position(|byte| *byte == b'\t') else {
                continue;
            };
            let header = &record[..separator];
            let Some(mode_end) = header.iter().position(|byte| *byte == b' ') else {
                continue;
            };
            if &header[..mode_end] != b"160000" {
                continue;
            }
            let path = &record[separator + 1..];
            digest.update(b"submodule-head\0");
            digest.update(path);
            digest.update([0]);
            let Some(child) = self.submodule_root(&canonical_repo, path)? else {
                digest.update(b"unavailable\0");
                continue;
            };
            let head = self.run(&child, &["rev-parse", "--verify", "HEAD"], 256, true)?;
            if head.ok {
                digest.update(b"present\0");
                digest.update(String::from_utf8_lossy(&head.bytes).trim().as_bytes());
            } else {
                digest.update(b"unborn\0");
            }
            let (files, status_revision) = self.files_with_status_revision(&child)?;
            digest.update(b"submodule-status\0");
            digest.update(status_revision);
            digest.update(b"submodule-dirty-path-metadata\0");
            digest.update(working_files_revision(&child, &files, fallback_nonce).as_bytes());
            digest.update(b"submodule-index\0");
            digest.update(self.index_revision_inner(&child, fallback_nonce, visited, depth + 1)?);
        }
        Ok(digest.finalize().into())
    }
    fn submodule_root(&self, repo: &Path, path: &[u8]) -> Result<Option<PathBuf>> {
        let relative = path_from_git_bytes(path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(Error::new("unsafePath", "子模块路径超出仓库范围。"));
        }
        let candidate = repo.join(relative);
        let Ok(metadata) = fs::symlink_metadata(&candidate) else {
            return Ok(None);
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Ok(None);
        }
        let Ok(candidate) = dunce::canonicalize(candidate) else {
            return Ok(None);
        };
        if !candidate.starts_with(repo) {
            return Err(Error::new("unsafePath", "子模块路径超出仓库范围。"));
        }
        let root = self.run(
            &candidate,
            &["rev-parse", "--show-toplevel"],
            READ_LIMIT,
            true,
        )?;
        if !root.ok {
            return Ok(None);
        }
        let root = dunce::canonicalize(
            String::from_utf8_lossy(&root.bytes).trim_end_matches(['\r', '\n']),
        )?;
        if root != candidate {
            return Ok(None);
        }
        Ok(Some(candidate))
    }
    pub fn worktrees(&self, repo: &Path) -> Result<Vec<Worktree>> {
        let raw = self.run(
            repo,
            &["worktree", "list", "--porcelain", "-z"],
            READ_LIMIT,
            false,
        )?;
        let mut trees = Vec::new();
        let mut tree: Option<Worktree> = None;
        for field in raw.bytes.split(|b| *b == 0) {
            let field = String::from_utf8_lossy(field);
            if field.is_empty() {
                if let Some(t) = tree.take() {
                    trees.push(t);
                }
            } else if let Some(path) = field.strip_prefix("worktree ") {
                let p = dunce::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
                tree = Some(Worktree {
                    id: repo_id(&p),
                    path: p.to_string_lossy().into(),
                    branch: String::new(),
                    current: p == repo,
                    available: p.is_dir(),
                    bare: false,
                });
            } else if let Some(t) = tree.as_mut() {
                if let Some(branch) = field.strip_prefix("branch refs/heads/") {
                    t.branch = branch.into();
                }
                if field == "detached" {
                    t.branch = "分离 HEAD".into();
                }
                if field == "bare" {
                    t.bare = true;
                }
            }
        }
        if let Some(t) = tree {
            trees.push(t);
        }
        Ok(trees)
    }
    pub fn snapshot(&self, repo: &Path) -> Result<Snapshot> {
        self.reject_partial_clone(repo)?;
        let normalized = self.repository_root(repo)?;
        if normalized != repo {
            return Err(Error::new(
                "notRepository",
                "原项目的 Git 信息已移除，请重新打开项目。",
            ));
        }
        // HEAD/引用前后核对，避免外部命令进行中混合两次仓库状态。
        for _ in 0..2 {
            let (head, refs, history_revision) = self.history_state(repo)?;
            let branch = self.text(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"], true)?;
            let (files, status_revision) = self.files_with_status_revision(repo)?;
            let fallback_nonce = SNAPSHOT_FALLBACK_NONCE.fetch_add(1, Ordering::Relaxed);
            let index_revision = self.index_revision(repo, fallback_nonce)?;
            let working_revision = working_files_revision(repo, &files, fallback_nonce);
            let mut digest = Sha256::new();
            digest.update(index_revision);
            digest.update(head.as_bytes());
            // A replace ref can change HEAD's effective tree without changing
            // the raw HEAD hash or the working-copy status rows.
            digest.update(history_revision.as_bytes());
            digest.update(working_revision.as_bytes());
            let changes_revision = format!("{:x}", digest.finalize());
            let upstream = self.text(
                repo,
                &[
                    "rev-parse",
                    "--abbrev-ref",
                    "--symbolic-full-name",
                    "@{upstream}",
                ],
                true,
            )?;
            let (mut ahead, mut behind) = (0, 0);
            if !head.is_empty() && !upstream.is_empty() {
                let counts = self.text(
                    repo,
                    &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
                    true,
                )?;
                let counts: Vec<_> = counts.split_whitespace().collect();
                if counts.len() == 2 {
                    ahead = counts[0].parse().unwrap_or(0);
                    behind = counts[1].parse().unwrap_or(0);
                }
            }
            let marker_paths = self.git_paths(
                repo,
                &[
                    "rebase-merge",
                    "rebase-apply",
                    "MERGE_HEAD",
                    "CHERRY_PICK_HEAD",
                    "REVERT_HEAD",
                ],
            )?;
            let operation = marker_paths
                .iter()
                .zip(["变基", "变基", "合并", "挑选提交", "撤销提交"])
                .find(|(path, _)| path.exists())
                .map(|(_, label)| label.to_owned());
            let stashes = self
                .text(repo, &["stash", "list", "--format=%gd%x00%gs"], false)?
                .lines()
                .filter_map(|l| {
                    l.split_once('\0').map(|(reference, subject)| Stash {
                        reference: reference.into(),
                        subject: subject.into(),
                    })
                })
                .collect();
            let worktrees = self.worktrees(repo)?;
            // status and the index are separate Git reads. Fence both sides, and
            // sample changed-file metadata again, so a concurrent `git add` or
            // edit cannot produce a mixed files/changesRevision snapshot.
            let (after_files, after_status_revision) = self.files_with_status_revision(repo)?;
            let after_index_revision = self.index_revision(repo, fallback_nonce)?;
            let after_working_revision = working_files_revision(repo, &after_files, fallback_nonce);
            let (_, _, after_history_revision) = self.history_state(repo)?;
            if status_revision != after_status_revision
                || index_revision != after_index_revision
                || working_revision != after_working_revision
                || after_history_revision != history_revision
            {
                continue;
            }
            return Ok(Snapshot {
                path: repo.to_string_lossy().into(),
                name: repo
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
                branch: if branch.is_empty() {
                    None
                } else {
                    Some(branch)
                },
                head: if head.is_empty() { None } else { Some(head) },
                refs,
                files,
                history_revision,
                changes_revision,
                upstream: if upstream.is_empty() {
                    None
                } else {
                    Some(upstream)
                },
                ahead,
                behind,
                operation,
                worktrees,
                stashes,
            });
        }
        Err(Error::new("changing", "Git 正在变化，稍后自动重新读取。"))
    }
    pub fn history(
        &self,
        repo: &Path,
        reference: &str,
        offset: usize,
        expected: &str,
    ) -> Result<HistoryPage> {
        self.reject_partial_clone(repo)?;
        let (head, refs, revision) = self.history_state(repo)?;
        if !expected.is_empty() && expected != revision {
            return Err(Error::new("staleHistory", "提交历史已变化，正在重新加载。"));
        }
        if reference != "all"
            && reference != "HEAD"
            && !refs.iter().any(|r| r.full_name == reference)
        {
            return Err(Error::new("missingReference", "这个分支或标签已被移除。"));
        }
        if (head.is_empty() && refs.is_empty()) || (reference == "HEAD" && head.is_empty()) {
            return Ok(HistoryPage {
                commits: vec![],
                has_more: false,
                offset,
                revision,
            });
        }
        let skip = format!("--skip={offset}");
        let mut args = vec![
            "log",
            "--topo-order",
            "--date-order",
            "-101",
            &skip,
            "--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%s",
        ];
        if reference == "all" {
            args.extend(["--branches", "--remotes", "--tags"]);
            if !head.is_empty() {
                args.push("HEAD");
            }
        } else {
            args.push(reference);
        }
        args.push("--");
        let raw = self.text(repo, &args, false)?;
        let mut commits: Vec<_> = raw.lines().filter_map(parse_commit).collect();
        let has_more = commits.len() > 100;
        commits.truncate(100);
        let (_, _, after) = self.history_state(repo)?;
        if revision != after {
            return Err(Error::new("staleHistory", "提交历史已变化，正在重新加载。"));
        }
        Ok(HistoryPage {
            commits,
            has_more,
            offset,
            revision,
        })
    }
    fn validate_commit_id(value: &str) -> Result<()> {
        if ![40, 64].contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::new("invalid", "提交 ID 无效。"));
        }
        Ok(())
    }
    pub fn commit(&self, repo: &Path, value: &str) -> Result<CommitDetail> {
        self.commit_at_revision(repo, value, None)
    }
    pub fn commit_at_revision(
        &self,
        repo: &Path,
        value: &str,
        expected_history_revision: Option<&str>,
    ) -> Result<CommitDetail> {
        self.reject_partial_clone(repo)?;
        let expected = self.check_expected_history(repo, expected_history_revision)?;
        let detail = self.commit_inner(repo, value)?;
        self.verify_expected_history_still_current(repo, expected.as_deref())?;
        Ok(detail)
    }
    pub fn commit_view_at_revision(
        &self,
        repo: &Path,
        value: &str,
        path: Option<&str>,
        expected_history_revision: Option<&str>,
    ) -> Result<CommitView> {
        self.reject_partial_clone(repo)?;
        let expected = self.check_expected_history(repo, expected_history_revision)?;
        let detail = self.commit_inner(repo, value)?;
        let file_path = match path {
            Some(path) => {
                validate_relative(path)?;
                if !detail.files.iter().any(|file| file.path == path) {
                    return Err(Error::new("invalid", "该提交中没有这个变更文件。"));
                }
                Some(path.to_owned())
            }
            None => detail.files.first().map(|file| file.path.clone()),
        };
        let diff = file_path
            .as_deref()
            .map(|path| self.commit_diff_with_lfs(repo, &detail, path))
            .transpose()?;
        self.verify_expected_history_still_current(repo, expected.as_deref())?;
        Ok(CommitView {
            detail,
            file_path,
            diff,
        })
    }
    fn commit_inner(&self, repo: &Path, value: &str) -> Result<CommitDetail> {
        Self::validate_commit_id(value)?;
        let commit = parse_commit(&self.text(
            repo,
            &[
                "show",
                "-s",
                "--format=%H%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%aI%x00%s",
                value,
            ],
            false,
        )?)
        .ok_or_else(|| Error::new("read", "提交内容读取失败。"))?;
        let mut args = vec![
            "diff-tree",
            "--root",
            "--no-commit-id",
            "-r",
            "--find-renames",
            "--name-status",
            "-z",
        ];
        if let Some(parent) = commit.parents.first() {
            args.push(parent);
        }
        args.push(&commit.hash);
        args.push("--");
        let out = self.run(repo, &args, READ_LIMIT, false)?;
        if out.truncated {
            return Err(Error::new(
                "tooLarge",
                "提交变更过大，无法完整读取文件列表。",
            ));
        }
        let entries: Vec<_> = out
            .bytes
            .split(|b| *b == 0)
            .filter(|e| !e.is_empty())
            .collect();
        let mut files = vec![];
        let mut i = 0;
        while i + 1 < entries.len() {
            let status = String::from_utf8_lossy(entries[i]).to_string();
            i += 1;
            let first = String::from_utf8_lossy(entries[i]).to_string();
            i += 1;
            let (path, old_path) = if status.starts_with('R') || status.starts_with('C') {
                if i >= entries.len() {
                    break;
                }
                let next = String::from_utf8_lossy(entries[i]).to_string();
                i += 1;
                (next, Some(first))
            } else {
                (first, None)
            };
            files.push(CommitFile {
                path,
                old_path,
                status,
            });
        }
        Ok(CommitDetail {
            comparison: if commit.parents.is_empty() {
                "首次提交，全部为新增内容"
            } else {
                "相对第一个父提交"
            }
            .into(),
            commit,
            files,
        })
    }
    fn commit_file_diff(&self, repo: &Path, detail: &CommitDetail, path: &str) -> Result<Diff> {
        validate_relative(path)?;
        let file = detail
            .files
            .iter()
            .find(|file| file.path == path)
            .ok_or_else(|| Error::new("invalid", "该提交中没有这个变更文件。"))?;
        let literal = format!(":(literal){path}");
        let mut owned_paths = vec![literal];
        if let Some(old) = &file.old_path {
            owned_paths.push(format!(":(literal){old}"));
        }
        let mut args = vec!["diff-tree", "--root", "--no-commit-id", "-r", "-p"];
        args.extend([
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            "--unified=3",
        ]);
        if let Some(parent) = detail.commit.parents.first() {
            args.push(parent);
        }
        args.push(&detail.commit.hash);
        args.push("--");
        args.extend(owned_paths.iter().map(String::as_str));
        let output = self.run(repo, &args, DIFF_LIMIT, false)?;
        let mut diff = Diff {
            patch: String::from_utf8_lossy(&output.bytes).into_owned(),
            truncated: output.truncated,
            binary: false,
            note: None,
            conflict: None,
            lfs: None,
            preview: None,
            encoding: None,
        };
        diff.binary = is_binary_patch(&diff.patch);
        if diff.patch.is_empty() {
            diff.note = Some("当前比较范围没有差异。".into());
        }
        Ok(diff)
    }
    fn commit_diff_with_lfs(&self, repo: &Path, detail: &CommitDetail, path: &str) -> Result<Diff> {
        let file = detail
            .files
            .iter()
            .find(|file| file.path == path)
            .ok_or_else(|| Error::new("invalid", "该提交中没有这个变更文件。"))?;
        let mut diff = self.commit_file_diff(repo, detail, path)?;
        diff.lfs = match self.commit_lfs_diff(
            repo,
            &detail.commit.hash,
            detail.commit.parents.first().map(String::as_str),
            file.old_path.as_deref(),
            path,
        ) {
            Ok(lfs) => lfs,
            Err(error) if error.kind == "lfsAttributeSourceUnsupported" => {
                diff.note = Some(error.message);
                None
            }
            Err(error) => return Err(error),
        };
        if diff.lfs.is_none() && diff.note.is_none() {
            let before = match detail.commit.parents.first() {
                Some(parent) => {
                    self.tree_blob(repo, parent, file.old_path.as_deref().unwrap_or(path))?
                }
                None => None,
            };
            let after = self.tree_blob(repo, &detail.commit.hash, path)?;
            self.enrich_blob_diff(repo, path, before, after, &mut diff)?;
        }
        Ok(diff)
    }
    pub fn diff(&self, repo: &Path, mode: &str, path: &str, commit: Option<&str>) -> Result<Diff> {
        self.diff_at_revision(repo, mode, path, commit, None)
    }
    pub fn diff_at_revision(
        &self,
        repo: &Path,
        mode: &str,
        path: &str,
        commit: Option<&str>,
        expected_history_revision: Option<&str>,
    ) -> Result<Diff> {
        self.reject_partial_clone(repo)?;
        let expected = if mode == "commit" {
            self.check_expected_history(repo, expected_history_revision)?
        } else {
            None
        };
        let diff = self.diff_inner(repo, mode, path, commit)?;
        self.verify_expected_history_still_current(repo, expected.as_deref())?;
        Ok(diff)
    }
    fn diff_inner(
        &self,
        repo: &Path,
        mode: &str,
        path: &str,
        commit: Option<&str>,
    ) -> Result<Diff> {
        validate_relative(path)?;
        if mode == "commit" {
            let detail = self.commit_inner(repo, commit.unwrap_or(""))?;
            return self.commit_diff_with_lfs(repo, &detail, path);
        }
        let literal = format!(":(literal){path}");
        let options = [
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            "--unified=3",
        ];
        let mut result = Diff {
            patch: String::new(),
            truncated: false,
            binary: false,
            note: None,
            conflict: None,
            lfs: None,
            preview: None,
            encoding: None,
        };
        let mut owned_paths = vec![literal];
        let output = if ["staged", "unstaged", "conflict"].contains(&mode) {
            let files = self.files(repo)?;
            let Some(file) = files.iter().find(|f| f.path == path).cloned() else {
                result.note = Some("该文件已没有待提交修改。".into());
                return Ok(result);
            };
            if mode == "conflict" && file.conflict {
                result.conflict = Some(self.conflict(repo, path, &file)?);
                result.lfs = self.conflict_lfs_diff(repo, path)?;
            }
            if file.untracked {
                let target = safe_file(repo, path)?;
                if !target.is_file() {
                    result.note = Some("这个对象不是普通文件，无法展示文本差异。".into());
                    return Ok(result);
                }
                let mut bytes = vec![];
                let uses_lfs = self.path_uses_lfs(repo, path, None, false)?;
                if uses_lfs {
                    let file = fs::File::open(target)?;
                    let pointer =
                        crate::lfs::clean(&mut &file, &mut bytes).map_err(|error| match error {
                            crate::lfs::CleanError::UnsupportedExtension => Error::new(
                                "unsupportedLfsExtension",
                                "暂不支持含 Git LFS 扩展字段的指针文件。",
                            ),
                            crate::lfs::CleanError::Io(error) => error.into(),
                        })?;
                    let after = pointer
                        .map(LfsPointer::from)
                        .map_or_else(LfsSide::regular, LfsSide::pointer);
                    result.lfs = Some(LfsDiff::from_sides(LfsSide::missing(), after));
                } else {
                    fs::File::open(target)?
                        .take((DIFF_LIMIT + 1) as u64)
                        .read_to_end(&mut bytes)?;
                    result.truncated = bytes.len() > DIFF_LIMIT;
                    bytes.truncate(DIFF_LIMIT);
                }
                if bytes.contains(&0) {
                    result.binary = true;
                    if result.lfs.is_none() {
                        result.truncated = false;
                        self.enrich_worktree_diff(repo, path, None, &mut result)?;
                    }
                    return Ok(result);
                }
                let content = String::from_utf8_lossy(&bytes);
                let lines: Vec<_> = content.split_inclusive('\n').collect();
                result.patch =
                    format!("--- /dev/null\n+++ {path}\n@@ -0,0 +1,{} @@\n", lines.len());
                for line in lines {
                    result.patch.push('+');
                    result.patch.push_str(line);
                    if !line.ends_with('\n') {
                        result.patch.push_str("\n\\ No newline at end of file\n");
                    }
                }
                if result.patch.len() > DIFF_LIMIT {
                    result.truncated = true;
                    result.patch = truncate_utf8(&result.patch, DIFF_LIMIT);
                }
                if result.lfs.is_none() {
                    self.enrich_worktree_diff(repo, path, None, &mut result)?;
                }
                return Ok(result);
            }
            if let Some(old) = &file.old_path {
                owned_paths.push(format!(":(literal){old}"));
            }
            let mut args = vec!["diff"];
            if mode == "staged" {
                args.push("--cached");
            }
            args.extend(options);
            args.push("--");
            args.extend(owned_paths.iter().map(String::as_str));
            let output = self.run(repo, &args, DIFF_LIMIT, false)?;
            if mode != "conflict" {
                result.lfs = self.workspace_lfs_diff(repo, mode, &file)?;
            }
            result.patch = String::from_utf8_lossy(&output.bytes).into();
            result.binary = is_binary_patch(&result.patch);
            result.truncated |= output.truncated;
            if result.lfs.is_none() {
                if mode == "conflict" && file.conflict {
                    let before = self.index_stage_blob(repo, path, "2")?;
                    let after = self.index_stage_blob(repo, path, "3")?;
                    self.enrich_blob_diff(repo, path, before, after, &mut result)?;
                } else if mode == "staged" {
                    let has_head = self
                        .run(repo, &["rev-parse", "--verify", "HEAD"], 256, true)?
                        .ok;
                    let before = if has_head {
                        self.tree_blob(repo, "HEAD", file.old_path.as_deref().unwrap_or(path))?
                    } else {
                        None
                    };
                    let after = self.index_blob(repo, path)?;
                    self.enrich_blob_diff(repo, path, before, after, &mut result)?;
                } else {
                    let before = self.index_blob(repo, path)?;
                    self.enrich_worktree_diff(repo, path, before, &mut result)?;
                }
            }
            output
        } else {
            return Err(Error::new("invalid", "差异类型无效。"));
        };
        let _ = output;
        if result.patch.is_empty() {
            result.note = Some("当前比较范围没有差异。".into());
        }
        Ok(result)
    }
    fn conflict(&self, repo: &Path, path: &str, file: &FileState) -> Result<Conflict> {
        let kind = match file.xy.as_str() {
            "UU" => "双方修改",
            "AA" => "双方新增",
            "UD" => "当前分支修改，合入方删除",
            "DU" => "当前分支删除，合入方修改",
            "AU" => "当前分支新增",
            "UA" => "合入方新增",
            "DD" => "双方删除",
            _ => "未解决冲突",
        };
        let mut result = Conflict {
            kind: kind.into(),
            blocks: vec![],
            note: None,
        };
        let target = safe_file(repo, path)?;
        if !target.exists() {
            result.note = Some("当前文件已删除，Git 仍记录着未解决冲突。".into());
            return Ok(result);
        }
        if !target.is_file() {
            result.note = Some("非普通文件冲突，无法按文本行展示。".into());
            return Ok(result);
        }
        let mut content = vec![];
        fs::File::open(target)?
            .take((DIFF_LIMIT + 1) as u64)
            .read_to_end(&mut content)?;
        let large = content.len() > DIFF_LIMIT;
        content.truncate(DIFF_LIMIT);
        if content.contains(&0) {
            result.note = Some("二进制文件冲突，无法按文本行展示。".into());
            return Ok(result);
        }
        let mut block: Option<ConflictBlock> = None;
        let mut side = 0;
        let mut size = 7;
        for (i, line) in String::from_utf8_lossy(&content).lines().enumerate() {
            let marker = line.chars().take_while(|c| *c == '<').count();
            if block.is_none()
                && marker >= 7
                && (line.len() == marker || line.as_bytes().get(marker) == Some(&b' '))
            {
                size = marker;
                side = 0;
                block = Some(ConflictBlock {
                    start_line: i + 1,
                    end_line: 0,
                    ours: vec![],
                    base: vec![],
                    theirs: vec![],
                    incoming: String::new(),
                });
            } else if let Some(b) = block.as_mut() {
                let marker_matches = |c: char| {
                    line == c.to_string().repeat(size)
                        || line.starts_with(&(c.to_string().repeat(size) + " "))
                };
                if side == 0 && marker_matches('|') {
                    side = 1;
                } else if side <= 1 && line == "=".repeat(size) {
                    side = 2;
                } else if side == 2 && marker_matches('>') {
                    b.end_line = i + 1;
                    b.incoming = line[size..].trim().into();
                    result.blocks.push(block.take().unwrap());
                } else {
                    let row = ConflictLine {
                        line: i + 1,
                        text: line.into(),
                    };
                    match side {
                        0 => b.ours.push(row),
                        1 => b.base.push(row),
                        _ => b.theirs.push(row),
                    }
                }
            }
        }
        if result.blocks.is_empty() {
            result.note = Some("文件中没有完整冲突标记；Git 暂存区仍有未解决记录。".into());
        }
        if large {
            result.note = Some("文件较大，只展示前 240 KB 内的完整冲突段。".into());
        }
        Ok(result)
    }
}
pub fn repo_id(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()))[..16].into()
}
fn history_id(head: &str, refs: &[Reference], context: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(head);
    digest.update(context);
    for r in refs {
        digest.update(&r.full_name);
        digest.update(&r.hash);
    }
    format!("{:x}", digest.finalize())
}
fn add_file_metadata(digest: &mut Sha256, path: &Path, metadata: &fs::Metadata) -> bool {
    digest.update(metadata.len().to_le_bytes());
    digest.update(format!("{:?}", metadata.modified().ok()).as_bytes());
    if let Some((seconds, nanoseconds)) = file_change_time(path, metadata) {
        digest.update(b"change-time\0");
        digest.update(seconds.to_le_bytes());
        digest.update(nanoseconds.to_le_bytes());
        true
    } else {
        false
    }
}
fn working_files_revision(repo: &Path, files: &[FileState], fallback_nonce: u64) -> String {
    let mut digest = Sha256::new();
    for file in files {
        digest.update(file.path.as_bytes());
        digest.update(file.xy.as_bytes());
        let path = repo.join(&file.path);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !add_file_metadata(&mut digest, &path, &metadata) {
                    // On filesystems without a readable change time, invalidate
                    // the diff cache per snapshot rather than reusing stale data.
                    digest.update(b"change-time-unavailable\0");
                    digest.update(fallback_nonce.to_le_bytes());
                }
            }
            Err(_) => digest.update(b"missing-file\0"),
        }
    }
    format!("{:x}", digest.finalize())
}
fn add_history_file_state(digest: &mut Sha256, path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            digest.update(b"missing\0");
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    digest.update(b"present\0");
    if add_file_metadata(digest, path, &metadata) {
        return Ok(());
    }

    // Change-time is available on supported Unix and Windows filesystems. If a
    // filesystem does not expose it, hash only these Git boundary files and cap
    // the read; failing closed avoids silently serving a stale history graph.
    if metadata.len() > READ_LIMIT as u64 {
        return Err(Error::new(
            "tooLarge",
            "Git 历史边界文件过大，无法安全校验。",
        ));
    }
    let file = fs::File::open(path)?;
    let mut contents = Vec::with_capacity(metadata.len() as usize);
    file.take(READ_LIMIT as u64 + 1)
        .read_to_end(&mut contents)?;
    if contents.len() > READ_LIMIT {
        return Err(Error::new(
            "tooLarge",
            "Git 历史边界文件过大，无法安全校验。",
        ));
    }
    digest.update(b"content-fallback\0");
    digest.update(Sha256::digest(contents));
    Ok(())
}
#[cfg(unix)]
fn file_change_time(_path: &Path, metadata: &fs::Metadata) -> Option<(i64, i64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.ctime(), metadata.ctime_nsec()))
}
#[cfg(windows)]
fn file_change_time(path: &Path, _metadata: &fs::Metadata) -> Option<(i64, i64)> {
    use std::{
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };

    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Open for metadata only and allow concurrent edits/renames. Opening the
    // reparse point itself keeps symlinks from redirecting this metadata read.
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut info = FILE_BASIC_INFO::default();
    let read = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            (&mut info as *mut FILE_BASIC_INFO).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        ) != 0
    };
    unsafe {
        CloseHandle(handle);
    }
    read.then_some((info.ChangeTime, 0))
}
#[cfg(not(any(unix, windows)))]
fn file_change_time(_path: &Path, _metadata: &fs::Metadata) -> Option<(i64, i64)> {
    None
}
fn validate_relative(path: &str) -> Result<()> {
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(Error::new("invalid", "文件路径无效。"));
    }
    Ok(())
}
fn safe_file(repo: &Path, relative: &str) -> Result<PathBuf> {
    validate_relative(relative)?;
    let target = repo.join(relative);
    let mut cursor = target.as_path();
    while cursor != repo {
        if fs::symlink_metadata(cursor).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::new("symlink", "符号链接内容不按普通文本文件读取。"));
        }
        cursor = cursor
            .parent()
            .ok_or_else(|| Error::new("invalid", "文件位于仓库外。"))?;
    }
    Ok(target)
}
fn is_binary_patch(patch: &str) -> bool {
    patch.lines().any(|line| {
        line == "GIT binary patch"
            || line
                .strip_prefix("Binary files ")
                .is_some_and(|metadata| metadata.ends_with(" differ"))
    })
}
#[cfg(unix)]
fn path_from_git_bytes(path: &[u8]) -> PathBuf {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    PathBuf::from(OsString::from_vec(path.to_vec()))
}
#[cfg(windows)]
fn path_from_git_bytes(path: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(path).into_owned())
}
#[cfg(not(any(unix, windows)))]
fn path_from_git_bytes(path: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(path).into_owned())
}
fn truncate_utf8(text: &str, cap: usize) -> String {
    let mut end = cap.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].into()
}
fn parse_commit(raw: &str) -> Option<Commit> {
    let p: Vec<_> = raw.splitn(8, '\0').collect();
    if p.len() != 8 {
        return None;
    }
    Some(Commit {
        hash: p[0].into(),
        parents: p[1].split_whitespace().map(str::to_owned).collect(),
        author: p[2].into(),
        author_email: p[3].into(),
        committer: p[4].into(),
        committer_email: p[5].into(),
        date: p[6].into(),
        subject: p[7].into(),
    })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub name: String,
    pub full_name: String,
    pub hash: String,
    pub kind: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    pub path: String,
    pub old_path: Option<String>,
    pub xy: String,
    pub untracked: bool,
    pub conflict: bool,
    pub staged: bool,
    pub unstaged: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub id: String,
    pub path: String,
    pub branch: String,
    pub current: bool,
    pub available: bool,
    pub bare: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Stash {
    pub reference: String,
    pub subject: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub refs: Vec<Reference>,
    pub files: Vec<FileState>,
    pub history_revision: String,
    pub changes_revision: String,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub operation: Option<String>,
    pub worktrees: Vec<Worktree>,
    pub stashes: Vec<Stash>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub committer: String,
    pub committer_email: String,
    pub date: String,
    pub subject: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub commits: Vec<Commit>,
    pub has_more: bool,
    pub offset: usize,
    pub revision: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct CommitDetail {
    #[serde(flatten)]
    pub commit: Commit,
    pub files: Vec<CommitFile>,
    pub comparison: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitView {
    pub detail: CommitDetail,
    pub file_path: Option<String>,
    pub diff: Option<Diff>,
}
#[derive(Clone, Serialize)]
pub struct Diff {
    pub patch: String,
    pub truncated: bool,
    pub binary: bool,
    pub note: Option<String>,
    pub conflict: Option<Conflict>,
    pub lfs: Option<LfsDiff>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<FilePreview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}
#[derive(Clone)]
struct GitBlob {
    mode: String,
    oid: String,
    stage: String,
}
struct IndexEntry {
    mode: Vec<u8>,
    oid: Vec<u8>,
    path: Vec<u8>,
}
#[derive(Clone)]
struct LfsSide {
    pointer: Option<LfsPointer>,
    state: LfsSideState,
}
impl LfsSide {
    fn pointer(pointer: LfsPointer) -> Self {
        Self {
            pointer: Some(pointer),
            state: LfsSideState::Pointer,
        }
    }
    fn regular() -> Self {
        Self {
            pointer: None,
            state: LfsSideState::Regular,
        }
    }
    fn missing() -> Self {
        Self {
            pointer: None,
            state: LfsSideState::Missing,
        }
    }
    fn unsupported() -> Self {
        Self {
            pointer: None,
            state: LfsSideState::Unsupported,
        }
    }
}
impl LfsDiff {
    fn from_sides(before: LfsSide, after: LfsSide) -> Self {
        Self {
            before: before.pointer,
            after: after.pointer,
            before_state: before.state,
            after_state: after.state,
            conflict: None,
        }
    }
}
impl From<crate::lfs::Pointer> for LfsPointer {
    fn from(pointer: crate::lfs::Pointer) -> Self {
        Self {
            oid: pointer.oid,
            size: pointer.size,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsDiff {
    pub before: Option<LfsPointer>,
    pub after: Option<LfsPointer>,
    pub before_state: LfsSideState,
    pub after_state: LfsSideState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LfsPointer {
    pub oid: String,
    pub size: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LfsSideState {
    Pointer,
    Regular,
    Missing,
    Unsupported,
}

fn parse_index_blob_record(record: &[u8]) -> Option<GitBlob> {
    let separator = record.iter().position(|byte| *byte == b'\t')?;
    let header: Vec<_> = record[..separator]
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty())
        .collect();
    if header.len() < 3 {
        return None;
    }
    Some(GitBlob {
        mode: String::from_utf8_lossy(header[0]).into_owned(),
        oid: String::from_utf8_lossy(header[1]).into_owned(),
        stage: String::from_utf8_lossy(header[2]).into_owned(),
    })
}

fn parse_tree_blob_record(record: &[u8]) -> Option<GitBlob> {
    let separator = record.iter().position(|byte| *byte == b'\t')?;
    let header: Vec<_> = record[..separator]
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty())
        .collect();
    if header.len() != 3 || header[1] != b"blob" {
        return None;
    }
    Some(GitBlob {
        mode: String::from_utf8_lossy(header[0]).into_owned(),
        oid: String::from_utf8_lossy(header[2]).into_owned(),
        stage: "0".into(),
    })
}
#[derive(Clone, Serialize)]
pub struct Conflict {
    pub kind: String,
    pub blocks: Vec<ConflictBlock>,
    pub note: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBlock {
    pub start_line: usize,
    pub end_line: usize,
    pub ours: Vec<ConflictLine>,
    pub base: Vec<ConflictLine>,
    pub theirs: Vec<ConflictLine>,
    pub incoming: String,
}
#[derive(Clone, Serialize)]
pub struct ConflictLine {
    pub line: usize,
    pub text: String,
}
