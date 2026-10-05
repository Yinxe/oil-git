//! Selected-file reads only. Blob reads bypass filters; no checkout, textconv or downloads.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

const MEDIA_LIMIT: usize = 8 * 1024 * 1024;
const HEX_LIMIT: usize = 4096;
const PIXEL_LIMIT: usize = 16_000_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub before: Option<PreviewSide>,
    pub after: Option<PreviewSide>,
    pub conflict: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSide {
    pub size: u64,
    pub mime: String,
    pub kind: String,
    pub data_url: Option<String>,
    pub width: Option<usize>,
    pub height: Option<usize>,
    pub hex: String,
    pub hex_truncated: bool,
    pub note: Option<String>,
}
struct Content {
    size: u64,
    bytes: Vec<u8>,
}

fn media_type(path: &str, bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    // Raster MIME is based on the actual header, not the filename.
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(("image", "image/png"));
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some(("image", "image/jpeg"));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(("image", "image/gif"));
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some(("image", "image/webp"));
    }
    if bytes.starts_with(b"BM") {
        return Some(("image", "image/bmp"));
    }
    if bytes.starts_with(b"II\x2a\0") || bytes.starts_with(b"MM\0\x2a") {
        return Some(("image", "image/tiff"));
    }
    if bytes.starts_with(b"\0\0\x01\0") {
        return Some(("image", "image/x-icon"));
    }
    if bytes.get(4..8) == Some(b"ftyp")
        && bytes
            .get(8..12)
            .is_some_and(|b| b == b"avif" || b == b"avis")
    {
        return Some(("image", "image/avif"));
    }
    if bytes.get(4..8) == Some(b"ftyp")
        && bytes
            .get(8..12)
            .is_some_and(|b| b == b"heic" || b == b"heix" || b == b"hevc" || b == b"hevx")
    {
        return Some(("image", "image/heic"));
    }
    let ext = path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    // SVG is only displayed in <img>, never executed as a document.
    if ext == "svg"
        && std::str::from_utf8(bytes).ok().is_some_and(|s| {
            let s = s.trim_start_matches('\u{feff}').trim_start();
            s.starts_with("<svg") || (s.starts_with("<?xml") && s.contains("<svg"))
        })
    {
        return Some(("image", "image/svg+xml"));
    }
    match ext.as_str() {
        "mp3" => Some(("audio", "audio/mpeg")),
        "wav" => Some(("audio", "audio/wav")),
        "ogg" | "oga" => Some(("audio", "audio/ogg")),
        "flac" => Some(("audio", "audio/flac")),
        "m4a" => Some(("audio", "audio/mp4")),
        "mp4" | "m4v" => Some(("video", "video/mp4")),
        "webm" => Some(("video", "video/webm")),
        "mov" => Some(("video", "video/quicktime")),
        _ => None,
    }
}
fn read_limit(path: &str, prefix: &[u8], size: u64) -> usize {
    if media_type(path, prefix).is_some() {
        if size <= MEDIA_LIMIT as u64 {
            MEDIA_LIMIT
        } else {
            HEX_LIMIT
        }
    } else {
        DIFF_LIMIT
    }
}
impl Git {
    fn preview_blob(
        &self,
        repo: &Path,
        path: &str,
        blob: Option<GitBlob>,
    ) -> Result<Option<Content>> {
        let Some(blob) = blob else {
            return Ok(None);
        };
        // Gitlinks are commits, never file bytes. Symlink blobs show their target text, not its contents.
        if !blob.mode.starts_with("100") {
            return Ok(None);
        }
        let checked = self.text(repo, &["cat-file", "-s", &blob.oid], false)?;
        let size = checked
            .parse::<u64>()
            .map_err(|_| Error::new("read", "文件对象大小无效。"))?;
        let prefix = self.run_prefix(repo, &["cat-file", "blob", &blob.oid], HEX_LIMIT)?;
        let limit = read_limit(path, &prefix.bytes, size);
        let bytes = if size > HEX_LIMIT as u64 && limit > HEX_LIMIT {
            self.run_prefix(repo, &["cat-file", "blob", &blob.oid], limit)?
                .bytes
        } else {
            prefix.bytes
        };
        if bytes.len() as u64 != size.min(limit as u64) {
            return Err(Error::new("read", "文件对象读取不完整。"));
        }
        Ok(Some(Content { size, bytes }))
    }
    fn preview_worktree(&self, repo: &Path, path: &str) -> Result<Option<Content>> {
        let target = match safe_file(repo, path) {
            Ok(target) => target,
            Err(error) if error.kind == "missing" || error.kind == "symlink" => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut file = match fs::File::open(&target) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Ok(None);
        }
        let size = metadata.len();
        let mut bytes = Vec::new();
        (&mut file).take(HEX_LIMIT as u64).read_to_end(&mut bytes)?;
        let limit = read_limit(path, &bytes, size);
        if limit > bytes.len() {
            (&mut file)
                .take((limit - bytes.len()) as u64)
                .read_to_end(&mut bytes)?;
        }
        // A changed file must not combine the old size with new content.
        let after = file.metadata()?;
        if size != after.len() || metadata.modified().ok() != after.modified().ok() {
            return Err(Error::new("changed", "文件在读取期间发生变化，请重试。"));
        }
        Ok(Some(Content { size, bytes }))
    }
    pub(super) fn enrich_blob_diff(
        &self,
        repo: &Path,
        path: &str,
        before: Option<GitBlob>,
        after: Option<GitBlob>,
        diff: &mut Diff,
    ) -> Result<()> {
        if !diff.binary && media_type(path, &[]).is_none() && !is_image_path(path) {
            return Ok(());
        }
        let before = self.preview_blob(repo, path, before)?;
        let after = self.preview_blob(repo, path, after)?;
        enrich(path, before, after, diff);
        Ok(())
    }
    pub(super) fn enrich_worktree_diff(
        &self,
        repo: &Path,
        path: &str,
        before: Option<GitBlob>,
        diff: &mut Diff,
    ) -> Result<()> {
        if !diff.binary && media_type(path, &[]).is_none() && !is_image_path(path) {
            return Ok(());
        }
        let before = self.preview_blob(repo, path, before)?;
        let after = self.preview_worktree(repo, path)?;
        enrich(path, before, after, diff);
        Ok(())
    }
}
fn is_image_path(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "ico"
            | "avif"
            | "svg"
            | "tif"
            | "tiff"
            | "heic"
            | "psd"
    )
}
fn unicode_text(content: &Content) -> Option<(String, &'static str)> {
    let bytes = &content.bytes;
    if content.size != bytes.len() as u64 {
        return None;
    }
    let (body, le, encoding) = if bytes.starts_with(&[0xff, 0xfe]) {
        (&bytes[2..], true, "UTF-16 LE")
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        (&bytes[2..], false, "UTF-16 BE")
    } else {
        let text = std::str::from_utf8(bytes).ok()?;
        if text
            .chars()
            .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t')))
        {
            return None;
        }
        return Some((text.trim_start_matches('\u{feff}').into(), "UTF-8"));
    };
    if body.len() % 2 != 0 {
        return None;
    }
    let units: Vec<_> = body
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            if le {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    let text = String::from_utf16(&units).ok()?;
    if text
        .chars()
        .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t')))
    {
        return None;
    }
    Some((text, encoding))
}
fn side(path: &str, content: Content) -> PreviewSide {
    let detected = media_type(path, &content.bytes);
    let binary_mime = if content.bytes.starts_with(b"%PDF-") {
        "application/pdf"
    } else if content.bytes.starts_with(b"PK\x03\x04") {
        "application/zip"
    } else if content.bytes.starts_with(b"\x1f\x8b") {
        "application/gzip"
    } else if content.bytes.starts_with(b"7z\xbc\xaf\x27\x1c") {
        "application/x-7z-compressed"
    } else if content.bytes.starts_with(b"wOFF") {
        "font/woff"
    } else if content.bytes.starts_with(b"wOF2") {
        "font/woff2"
    } else {
        "application/octet-stream"
    };
    let (kind, mime) = detected.unwrap_or(("binary", binary_mime));
    let dimensions = if kind == "image" {
        imagesize::blob_size(&content.bytes).ok()
    } else {
        None
    };
    let too_many_pixels = dimensions
        .as_ref()
        .is_some_and(|d| d.width.saturating_mul(d.height) > PIXEL_LIMIT);
    let complete = content.size == content.bytes.len() as u64;
    let note = if detected.is_some() && !complete {
        Some("文件超过 8 MiB 预览上限，显示文件信息和前 4 KiB 字节。".into())
    } else if too_many_pixels {
        Some("图片超过 1600 万像素预览上限，显示文件信息和字节。".into())
    } else {
        None
    };
    let data_url = if detected.is_some() && complete && !too_many_pixels {
        Some(format!(
            "data:{mime};base64,{}",
            STANDARD.encode(&content.bytes)
        ))
    } else {
        None
    };
    PreviewSide {
        size: content.size,
        kind: kind.into(),
        mime: mime.into(),
        data_url,
        width: dimensions.as_ref().map(|d| d.width),
        height: dimensions.as_ref().map(|d| d.height),
        hex: content
            .bytes
            .iter()
            .take(HEX_LIMIT)
            .map(|b| format!("{b:02x}"))
            .collect(),
        hex_truncated: content.size > HEX_LIMIT as u64,
        note,
    }
}
fn enrich(path: &str, before: Option<Content>, after: Option<Content>, diff: &mut Diff) {
    // Respect an explicit Git binary attribute while still making actual Unicode text readable.
    let text_before = before
        .as_ref()
        .map(unicode_text)
        .unwrap_or(Some((String::new(), "")));
    let text_after = after
        .as_ref()
        .map(unicode_text)
        .unwrap_or(Some((String::new(), "")));
    if diff.binary
        && diff.conflict.is_none()
        && before
            .as_ref()
            .into_iter()
            .chain(after.as_ref())
            .all(|c| media_type(path, &c.bytes).is_none())
    {
        if let (Some((old, old_encoding)), Some((new, new_encoding))) = (text_before, text_after) {
            let text_diff = similar::TextDiff::configure()
                .timeout(Duration::from_millis(200))
                .diff_lines(&old, &new);
            let patch = text_diff
                .unified_diff()
                .context_radius(3)
                .header(path, path)
                .to_string();
            diff.encoding = Some(if old_encoding == new_encoding || old_encoding.is_empty() {
                new_encoding.into()
            } else if new_encoding.is_empty() {
                old_encoding.into()
            } else {
                format!("{old_encoding} → {new_encoding}")
            });
            if !patch.is_empty() {
                diff.truncated = patch.len() > DIFF_LIMIT;
                diff.patch = truncate_utf8(&patch, DIFF_LIMIT);
                diff.binary = false;
                return;
            }
            diff.note = Some(
                if before
                    .as_ref()
                    .zip(after.as_ref())
                    .is_some_and(|(old, new)| old.bytes == new.bytes)
                {
                    "文本内容相同，变化来自路径或文件模式。"
                } else {
                    "文本内容相同，编码或字节表示发生变化。"
                }
                .into(),
            );
        }
    }
    diff.preview = Some(FilePreview {
        before: before.map(|c| side(path, c)),
        after: after.map(|c| side(path, c)),
        conflict: diff.conflict.is_some(),
    });
}
