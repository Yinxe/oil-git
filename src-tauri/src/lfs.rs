use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};

pub const CLEAN_COMMAND: &str = "__oil_lfs_clean";
pub const FILTER_PROCESS_COMMAND: &str = "__oil_lfs_filter_process";
const POINTER_LIMIT: usize = 1024;
const READ_CHUNK: usize = 8192;
const MAX_PACKET_LENGTH: usize = 0xfff0;
const MAX_PACKET_DATA: usize = MAX_PACKET_LENGTH - 4;
const MAX_SECTION_SIZE: usize = 64 * 1024;
const VERSION: &[u8] = b"version https://git-lfs.github.com/spec/v1";
const VERSION_ALIASES: [&[u8]; 2] = [
    b"version http://git-media.io/v/2",
    b"version https://hawser.github.com/spec/v1",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pointer {
    pub oid: String,
    pub size: u64,
}

#[derive(Debug)]
pub enum CleanError {
    Io(io::Error),
    UnsupportedExtension,
}

impl From<io::Error> for CleanError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl std::fmt::Display for CleanError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::UnsupportedExtension => {
                formatter.write_str("Git LFS pointer extensions are not supported")
            }
        }
    }
}

impl std::error::Error for CleanError {}

/// Read a small, legal v1 pointer from bytes without rewriting its spelling.
/// Larger buffers are never pointers: the LFS pointer specification caps them
/// below 1024 bytes.
pub fn parse_pointer(bytes: &[u8]) -> Option<Pointer> {
    if bytes.len() >= POINTER_LIMIT {
        return None;
    }
    match recognize_pointer(bytes)? {
        PointerRecognition::Standard(pointer) => Some(pointer),
        PointerRecognition::Extension => None,
    }
}

/// Detect extension records on a v1 LFS pointer before the clean path can hash
/// them as ordinary file bytes. The input may be a bounded prefix of a larger
/// file, so a complete pointer is not required here.
pub fn has_unsupported_extension(bytes: &[u8]) -> bool {
    matches!(
        recognize_pointer(bytes),
        Some(PointerRecognition::Extension)
    )
}

enum PointerRecognition {
    Standard(Pointer),
    Extension,
}

fn recognize_pointer(bytes: &[u8]) -> Option<PointerRecognition> {
    if bytes.len() >= POINTER_LIMIT {
        return None;
    }
    let lines = pointer_lines(bytes);
    let mut next_key = 0_u8;
    let mut oid = None;
    let mut size = None;
    let mut priorities = std::collections::HashSet::new();
    let mut has_extensions = false;
    for line in lines {
        if let Some(priority) = parse_extension_line(line) {
            if next_key >= 3 || !priorities.insert(priority) {
                return None;
            }
            has_extensions = true;
            continue;
        }
        match next_key {
            0 if VERSION_ALIASES.contains(&line) || line == VERSION => next_key = 1,
            1 => {
                let value = line.strip_prefix(b"oid sha256:")?;
                if value.len() != 64
                    || !value
                        .iter()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
                {
                    return None;
                }
                oid = Some(std::str::from_utf8(value).ok()?.to_owned());
                next_key = 2;
            }
            2 => {
                let value = line.strip_prefix(b"size ")?;
                let digits = value
                    .strip_prefix(b"+")
                    .or_else(|| value.strip_prefix(b"-"))
                    .unwrap_or(value);
                if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
                    return None;
                }
                let parsed: i64 = std::str::from_utf8(value).ok()?.parse().ok()?;
                if parsed < 0 {
                    return None;
                }
                size = Some(parsed as u64);
                next_key = 3;
            }
            _ => return None,
        }
    }
    if next_key != 3 {
        return None;
    }
    if has_extensions {
        return Some(PointerRecognition::Extension);
    }
    Some(PointerRecognition::Standard(Pointer {
        oid: oid?,
        size: size?,
    }))
}

fn parse_extension_line(line: &[u8]) -> Option<u8> {
    let (key, value) = line.split_once_byte(b' ')?;
    let rest = key.strip_prefix(b"ext-")?;
    let (priority, name) = rest.split_once_byte(b'-')?;
    if priority.len() != 1
        || !priority[0].is_ascii_digit()
        || name.is_empty()
        || !name
            .first()
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
    {
        return None;
    }
    let oid = value.strip_prefix(b"sha256:")?;
    if oid.len() != 64
        || !oid
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return None;
    }
    Some(priority[0] - b'0')
}

trait ByteSliceSplitOnce {
    fn split_once_byte(&self, separator: u8) -> Option<(&[u8], &[u8])>;
}

impl ByteSliceSplitOnce for [u8] {
    fn split_once_byte(&self, separator: u8) -> Option<(&[u8], &[u8])> {
        let index = self.iter().position(|byte| *byte == separator)?;
        Some((&self[..index], &self[index + 1..]))
    }
}

fn pointer_lines(bytes: &[u8]) -> Vec<&[u8]> {
    let bytes = trim_pointer_whitespace(bytes);
    let mut lines = bytes.split(|byte| *byte == b'\n').collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    for line in &mut lines {
        if let Some(without_cr) = line.strip_suffix(b"\r") {
            *line = without_cr;
        }
    }
    lines.into_iter().filter(|line| !line.is_empty()).collect()
}

fn trim_pointer_whitespace(mut bytes: &[u8]) -> &[u8] {
    // Exact UTF-8 encodings of Go unicode.IsSpace. Decode only the edges,
    // as bytes.TrimSpace does; invalid bytes in an extension name must not
    // bypass its explicit rejection by changing the pointer into plain data.
    loop {
        let count = match bytes {
            [b'\t'..=b'\r' | b' ', ..] => 1,
            [0xc2, 0x85 | 0xa0, ..] => 2,
            [0xe1, 0x9a, 0x80, ..]
            | [0xe2, 0x80, 0x80..=0x8a | 0xa8 | 0xa9 | 0xaf, ..]
            | [0xe2, 0x81, 0x9f, ..]
            | [0xe3, 0x80, 0x80, ..] => 3,
            _ => break,
        };
        bytes = &bytes[count..];
    }
    loop {
        let count = match bytes {
            [.., b'\t'..=b'\r' | b' '] => 1,
            [.., 0xc2, 0x85 | 0xa0] => 2,
            [.., 0xe1, 0x9a, 0x80]
            | [.., 0xe2, 0x80, 0x80..=0x8a | 0xa8 | 0xa9 | 0xaf]
            | [.., 0xe2, 0x81, 0x9f]
            | [.., 0xe3, 0x80, 0x80] => 3,
            _ => break,
        };
        bytes = &bytes[..bytes.len() - count];
    }
    bytes
}

/// Stream a worktree file through the canonical LFS clean conversion.
///
/// Empty input stays empty. A legal pointer smaller than 1024 bytes passes
/// through byte-for-byte. Other files are hashed with bounded memory and emit
/// the standard three-line v1 pointer. LFS extension pointers fail closed.
pub fn clean<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
) -> Result<Option<Pointer>, CleanError> {
    let mut prefix = Vec::with_capacity(POINTER_LIMIT + 1);
    let mut buffer = [0_u8; READ_CHUNK];
    let mut eof = false;
    while prefix.len() <= POINTER_LIMIT {
        let needed = (POINTER_LIMIT + 1 - prefix.len()).min(buffer.len());
        let count = reader.read(&mut buffer[..needed])?;
        if count == 0 {
            eof = true;
            break;
        }
        prefix.extend_from_slice(&buffer[..count]);
    }

    if prefix.is_empty() && eof {
        return Ok(None);
    }
    if eof && prefix.len() < POINTER_LIMIT && has_unsupported_extension(&prefix) {
        return Err(CleanError::UnsupportedExtension);
    }
    if eof {
        if let Some(pointer) = parse_pointer(&prefix) {
            writer.write_all(&prefix)?;
            return Ok(Some(pointer));
        }
    }

    let mut hasher = Sha256::new();
    hasher.update(&prefix);
    let mut size = u64::try_from(prefix.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "file size exceeds u64"))?;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "file size exceeds u64"))?;
        hasher.update(&buffer[..count]);
    }
    let oid = format!("{:x}", hasher.finalize());
    let pointer = Pointer { oid, size };
    write!(
        writer,
        "version https://git-lfs.github.com/spec/v1\noid sha256:{}\nsize {}\n",
        pointer.oid, pointer.size
    )?;
    Ok(Some(pointer))
}

pub fn run_clean() -> i32 {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    match clean(&mut reader, &mut writer).and_then(|_| writer.flush().map_err(CleanError::Io)) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("oil-git: {error}");
            1
        }
    }
}

#[derive(Debug)]
enum Packet {
    Data(Vec<u8>),
    Flush,
}

fn read_packet<R: Read>(reader: &mut R) -> io::Result<Option<Packet>> {
    let mut header = [0_u8; 4];
    match reader.read(&mut header[..1])? {
        0 => return Ok(None),
        1 => {}
        _ => unreachable!(),
    }
    reader.read_exact(&mut header[1..])?;
    let length = std::str::from_utf8(&header)
        .ok()
        .and_then(|value| usize::from_str_radix(value, 16).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid pkt-line header"))?;
    if length == 0 {
        return Ok(Some(Packet::Flush));
    }
    if !(4..=MAX_PACKET_LENGTH).contains(&length) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "pkt-line length is outside the supported range",
        ));
    }
    let mut payload = vec![0_u8; length - 4];
    reader.read_exact(&mut payload)?;
    Ok(Some(Packet::Data(payload)))
}

fn read_section<R: Read>(reader: &mut R) -> io::Result<Option<Vec<Vec<u8>>>> {
    let mut records = Vec::new();
    let mut total_size = 0_usize;
    loop {
        match read_packet(reader)? {
            Some(Packet::Data(data)) => {
                total_size = total_size.checked_add(data.len()).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "pkt-line section is too large")
                })?;
                if total_size > MAX_SECTION_SIZE || records.len() >= 128 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "pkt-line section exceeds the supported size",
                    ));
                }
                records.push(data);
            }
            Some(Packet::Flush) => return Ok(Some(records)),
            None if records.is_empty() => return Ok(None),
            None => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "EOF inside pkt-line section",
                ));
            }
        }
    }
}

fn write_packet<W: Write>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_PACKET_DATA {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pkt-line payload is too large",
        ));
    }
    write!(writer, "{:04x}", payload.len() + 4)?;
    writer.write_all(payload)
}

fn write_flush<W: Write>(writer: &mut W) -> io::Result<()> {
    writer.write_all(b"0000")
}

struct PacketReader<'a, R> {
    reader: &'a mut R,
    current: Vec<u8>,
    offset: usize,
    done: bool,
}

impl<'a, R: Read> PacketReader<'a, R> {
    fn new(reader: &'a mut R) -> Self {
        Self {
            reader,
            current: Vec::new(),
            offset: 0,
            done: false,
        }
    }
}

impl<R: Read> Read for PacketReader<'_, R> {
    fn read(&mut self, destination: &mut [u8]) -> io::Result<usize> {
        if destination.is_empty() || self.done {
            return Ok(0);
        }
        loop {
            if self.offset < self.current.len() {
                let count = (self.current.len() - self.offset).min(destination.len());
                destination[..count]
                    .copy_from_slice(&self.current[self.offset..self.offset + count]);
                self.offset += count;
                return Ok(count);
            }
            self.current.clear();
            self.offset = 0;
            match read_packet(self.reader)? {
                Some(Packet::Data(data)) => self.current = data,
                Some(Packet::Flush) => {
                    self.done = true;
                    return Ok(0);
                }
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "EOF before pkt-line content flush",
                    ));
                }
            }
        }
    }
}

fn write_filter_error<W: Write>(writer: &mut W) -> io::Result<()> {
    write_packet(writer, b"status=error\n")?;
    write_flush(writer)?;
    writer.flush()
}

fn protocol_field_is(field: &[u8], expected: &[u8]) -> bool {
    field.strip_suffix(b"\n").unwrap_or(field) == expected
}

/// Speak Git's version 2 filter-process protocol and expose only clean.
/// The process owns no repository paths and services multiple clean requests.
pub fn filter_process<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> io::Result<()> {
    let client = read_section(reader)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "missing filter-process handshake",
        )
    })?;
    if client.len() != 2
        || !protocol_field_is(&client[0], b"git-filter-client")
        || !protocol_field_is(&client[1], b"version=2")
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported filter-process handshake",
        ));
    }
    write_packet(writer, b"git-filter-server")?;
    write_packet(writer, b"version=2")?;
    write_flush(writer)?;
    write_packet(writer, b"capability=clean")?;
    write_flush(writer)?;
    writer.flush()?;
    let client_capabilities = read_section(reader)?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "missing filter-process client capabilities",
        )
    })?;
    if !client_capabilities
        .iter()
        .any(|field| protocol_field_is(field, b"capability=clean"))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "client did not offer clean capability",
        ));
    }

    loop {
        let Some(header) = read_section(reader)? else {
            return Ok(());
        };
        let is_clean = header
            .iter()
            .any(|field| protocol_field_is(field, b"command=clean"));
        let is_smudge = header
            .iter()
            .any(|field| protocol_field_is(field, b"command=smudge"));
        if !is_clean || is_smudge {
            write_filter_error(writer)?;
            return Ok(());
        }

        let mut body = PacketReader::new(reader);
        let mut content = Vec::with_capacity(POINTER_LIMIT + 1);
        match clean(&mut body, &mut content) {
            Ok(_) => {
                write_packet(writer, b"status=success\n")?;
                write_flush(writer)?;
                for chunk in content.chunks(MAX_PACKET_DATA) {
                    write_packet(writer, chunk)?;
                }
                write_flush(writer)?;
                write_flush(writer)?;
                writer.flush()?;
            }
            Err(CleanError::UnsupportedExtension) => {
                write_filter_error(writer)?;
                return Ok(());
            }
            Err(CleanError::Io(error)) => return Err(error),
        }
    }
}

pub fn run_filter_process() -> i32 {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    match filter_process(&mut reader, &mut writer) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("oil-git: filter process failed: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn pkt(payload: &[u8], target: &mut Vec<u8>) {
        write_packet(target, payload).unwrap();
    }

    fn request(data: &[u8], target: &mut Vec<u8>) {
        pkt(b"command=clean\n", target);
        pkt(b"pathname=some path\n", target);
        write_flush(target).unwrap();
        for chunk in data.chunks(37) {
            pkt(chunk, target);
        }
        write_flush(target).unwrap();
    }

    #[test]
    fn clean_keeps_empty_and_legal_pointer_bytes() {
        let mut output = Vec::new();
        assert_eq!(
            clean(&mut Cursor::new(Vec::<u8>::new()), &mut output).unwrap(),
            None
        );
        assert!(output.is_empty());

        let pointer = b"version https://git-lfs.github.com/spec/v1\r\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\nsize 12\r\n";
        let parsed = clean(&mut Cursor::new(pointer), &mut output)
            .unwrap()
            .unwrap();
        assert_eq!(parsed.oid, "a".repeat(64));
        assert_eq!(parsed.size, 12);
        assert_eq!(output, pointer);
    }

    #[test]
    fn clean_hashes_content_streaming_and_emits_canonical_pointer() {
        let content = vec![b'x'; POINTER_LIMIT * 4 + 3];
        let expected_oid = format!("{:x}", Sha256::digest(&content));
        let mut output = Vec::new();
        let pointer = clean(&mut Cursor::new(&content), &mut output)
            .unwrap()
            .unwrap();
        assert_eq!(pointer.oid, expected_oid);
        assert_eq!(pointer.size, content.len() as u64);
        assert_eq!(
            output,
            format!(
                "version https://git-lfs.github.com/spec/v1\noid sha256:{expected_oid}\nsize {}\n",
                content.len()
            )
            .as_bytes()
        );
    }

    #[test]
    fn extension_pointers_fail_closed() {
        let pointer = b"ext-0-filter sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nversion https://git-lfs.github.com/spec/v1\noid sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nsize 12\n";
        assert!(matches!(
            clean(&mut Cursor::new(pointer), &mut Vec::new()),
            Err(CleanError::UnsupportedExtension)
        ));
        assert!(has_unsupported_extension(pointer));
        // git-lfs extRE matches the initial word, allowing punctuation in
        // the remaining name. These still require an unsupported extension.
        for name in ["filter-name", "filter.name"] {
            let pointer = format!("version https://git-lfs.github.com/spec/v1\next-0-{name} sha256:{}\noid sha256:{}\nsize 12\n", "a".repeat(64), "b".repeat(64));
            assert!(has_unsupported_extension(pointer.as_bytes()));
            assert!(matches!(
                clean(&mut Cursor::new(pointer.as_bytes()), &mut Vec::new()),
                Err(CleanError::UnsupportedExtension)
            ));
        }
        let invalid_name = [b"version https://git-lfs.github.com/spec/v1\next-0-filter".as_slice(), &[0xff], b" sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\noid sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nsize 12\n"].concat();
        for space in [
            b" ".as_slice(),
            "\u{00a0}".as_bytes(),
            "\u{2003}".as_bytes(),
        ] {
            let input = [space, invalid_name.as_slice(), space].concat();
            assert!(has_unsupported_extension(&input));
            assert!(matches!(
                clean(&mut Cursor::new(input), &mut Vec::new()),
                Err(CleanError::UnsupportedExtension)
            ));
        }
    }

    #[test]
    fn extension_looking_content_at_pointer_cutoff_is_regular_file_data() {
        let mut content = b"version https://git-lfs.github.com/spec/v1\next-0-filter sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\noid sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nsize 12\n".to_vec();
        content.resize(1709, b'x');
        let expected_oid = format!("{:x}", Sha256::digest(&content));
        let mut output = Vec::new();
        let pointer = clean(&mut Cursor::new(&content), &mut output)
            .unwrap()
            .unwrap();
        assert_eq!(pointer.oid, expected_oid);
        assert_eq!(pointer.size, content.len() as u64);
    }

    #[test]
    fn pointer_cleaning_matches_git_lfs_38_clean_matrix() {
        let oid = "a".repeat(64);
        let accepted = [
            (
                format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize 12\n"),
                12,
            ),
            (
                format!(
                    "version https://git-lfs.github.com/spec/v1\r\noid sha256:{oid}\r\nsize 12\r\n"
                ),
                12,
            ),
            (
                format!("version https://hawser.github.com/spec/v1\noid sha256:{oid}\nsize 12\n"),
                12,
            ),
            (
                format!("version http://git-media.io/v/2\noid sha256:{oid}\nsize 12\n"),
                12,
            ),
            (
                format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize 12"),
                12,
            ),
            (
                format!(
                    "\nversion https://git-lfs.github.com/spec/v1\n\noid sha256:{oid}\nsize 12\n\n"
                ),
                12,
            ),
            (
                format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize +12\n"),
                12,
            ),
            (
                format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize 12 \n"),
                12,
            ),
            (
                format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize -0\n"),
                0,
            ),
        ];
        for (input, expected_size) in accepted {
            let input = input.into_bytes();
            let mut output = Vec::new();
            let parsed = clean(&mut Cursor::new(&input), &mut output)
                .unwrap()
                .unwrap();
            assert_eq!(parsed.oid, oid);
            assert_eq!(parsed.size, expected_size);
            assert_eq!(output, input);
        }

        let rejected = [
            format!("version https://git-lfs.github.com/spec/v1\nsize 12\noid sha256:{oid}\n"),
            format!("version https://git-lfs.github.com/spec/v1\nextra-field keep\noid sha256:{oid}\nsize 12\n"),
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize 12\nsize 13\n"),
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\noid sha256:{}\nsize 12\n", "b".repeat(64)),
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize 12\nextra-field after\n"),
        ];
        for input in rejected {
            let input = input.into_bytes();
            let expected_oid = format!("{:x}", Sha256::digest(&input));
            let expected = format!(
                "version https://git-lfs.github.com/spec/v1\noid sha256:{expected_oid}\nsize {}\n",
                input.len()
            );
            let mut output = Vec::new();
            let parsed = clean(&mut Cursor::new(&input), &mut output)
                .unwrap()
                .unwrap();
            assert_eq!(parsed.oid, expected_oid);
            assert_eq!(parsed.size, input.len() as u64);
            assert_eq!(output, expected.as_bytes());
        }
    }

    #[test]
    fn pointer_boundary_whitespace_matches_go_trim_space() {
        let oid = "a".repeat(64);
        let canonical =
            format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize 12\n");
        // Golden inputs checked against stock Git LFS 3.8.0 clean.
        for character in [
            '\t', '\n', '\u{000b}', '\u{000c}', '\r', ' ', '\u{0085}', '\u{00a0}', '\u{1680}',
            '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}',
            '\u{2007}', '\u{2008}', '\u{2009}', '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}',
            '\u{205f}', '\u{3000}',
        ] {
            let input = format!("{character}{canonical}{character}").into_bytes();
            let mut output = Vec::new();
            let pointer = clean(&mut Cursor::new(&input), &mut output)
                .unwrap()
                .unwrap();
            assert_eq!(pointer.oid, oid);
            assert_eq!(pointer.size, 12);
            assert_eq!(output, input);
        }
        for prefix in [
            "\u{feff}".as_bytes(),
            "\u{180e}".as_bytes(),
            "\u{200b}".as_bytes(),
            &[0xff],
        ] {
            let input = [prefix, canonical.as_bytes()].concat();
            let mut output = Vec::new();
            let pointer = clean(&mut Cursor::new(&input), &mut output)
                .unwrap()
                .unwrap();
            assert_eq!(pointer.oid, format!("{:x}", Sha256::digest(&input)));
            assert_eq!(pointer.size, input.len() as u64);
        }
    }

    #[test]
    fn filter_process_handles_multiple_requests_and_eof() {
        let mut input = Vec::new();
        pkt(b"git-filter-client\n", &mut input);
        pkt(b"version=2\n", &mut input);
        write_flush(&mut input).unwrap();
        pkt(b"capability=clean\n", &mut input);
        pkt(b"capability=smudge\n", &mut input);
        pkt(b"capability=delay\n", &mut input);
        write_flush(&mut input).unwrap();
        request(b"one", &mut input);
        request(b"", &mut input);

        let mut output = Vec::new();
        filter_process(&mut Cursor::new(input), &mut output).unwrap();
        let mut cursor = Cursor::new(output);
        assert_eq!(
            read_section(&mut cursor).unwrap().unwrap(),
            vec![b"git-filter-server".to_vec(), b"version=2".to_vec()]
        );
        assert_eq!(
            read_section(&mut cursor).unwrap().unwrap(),
            vec![b"capability=clean".to_vec()]
        );
        assert_eq!(
            read_section(&mut cursor).unwrap().unwrap(),
            vec![b"status=success\n".to_vec()]
        );
        let body = read_section(&mut cursor).unwrap().unwrap();
        assert_eq!(body.concat(), b"version https://git-lfs.github.com/spec/v1\noid sha256:7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed\nsize 3\n");
        assert!(matches!(
            read_packet(&mut cursor).unwrap(),
            Some(Packet::Flush)
        ));
        assert_eq!(
            read_section(&mut cursor).unwrap().unwrap(),
            vec![b"status=success\n".to_vec()]
        );
        assert!(read_section(&mut cursor).unwrap().unwrap().is_empty());
        assert!(matches!(
            read_packet(&mut cursor).unwrap(),
            Some(Packet::Flush)
        ));
        assert!(read_section(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn filter_process_rejects_oversized_pkt_lines_and_mid_packet_eof() {
        let mut oversized = b"ffff".to_vec();
        oversized.resize(65535, b'x');
        assert_eq!(
            read_packet(&mut Cursor::new(oversized)).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            read_packet(&mut Cursor::new(b"000".as_slice()))
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
