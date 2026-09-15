//! Chrome native-messaging relay: stdio frames in, a local socket out.
//!
//! ## Why this exists at all
//!
//! Chrome will only talk to a native messaging host it SPAWNS ITSELF, over that
//! child's stdin and stdout. The Atlarix desktop app is already running and is
//! not that child, so something has to sit between them. This is that something,
//! and it is deliberately the dumbest program in the repository: it copies bytes.
//!
//! ## Why it is not the Electron binary
//!
//! Two reasons, and the first is fatal rather than merely untidy.
//!
//! `forge.config.ts` sets `FuseV1Options.RunAsNode: false`. In a packaged build
//! the Atlarix binary therefore **cannot** be made to run a script as Node —
//! `ELECTRON_RUN_AS_NODE=1` is ignored, the binary boots Chromium instead, and
//! Chrome reports only "Error when communicating with the native messaging
//! host". It works perfectly under `npm start`, passes every test, and dies
//! exactly once: in the build that ships. The fuse is off for a good reason (it
//! lets any local process run arbitrary JS under Atlarix's signature and TCC
//! grants) so the answer is a separate binary, not a weaker fuse.
//!
//! Second, and independently: Chromium writes to stdout unprompted — `objc[…]`
//! warnings, GPU and ANGLE chatter, Metal noise. Native messaging has **no
//! resynchronisation**. One stray byte on fd 1 desynchronises the 4-byte length
//! prefix permanently and every later frame is garbage. This process writes
//! nothing to stdout that is not a frame, which is a property a browser engine
//! cannot offer.
//!
//! ## The framing, which is the same on both sides on purpose
//!
//! Chrome's protocol is a 4-byte length prefix in the machine's native byte
//! order followed by that many bytes of UTF-8 JSON. The desktop's socket speaks
//! **exactly the same framing**, which is what lets this be a raw byte copy
//! rather than a parser. A relay that parsed would have to re-emit, and every
//! re-emission is a chance to get a length wrong; a relay that copies cannot.
//!
//! The one place framing is constructed here is the unavailable notice below,
//! because a program that must say "nobody is listening" cannot do it by
//! copying.
//!
//! ## The size limits are asymmetric, and the small one is on the way IN
//!
//! Chrome caps a message from the host to the extension at **1 MB**, and a
//! message from the extension to the host at 4 GB. Requests travel
//! desktop → extension and are small; a page snapshot travels
//! extension → desktop and is the large one. So the tight limit sits on the
//! direction that carries almost nothing, which is the right way round — but it
//! is the desktop's job to keep a request under 1 MB, because exceeding it is
//! not an error this program can see. It is copying bytes.

use std::io::{self, Read, Write};

/// Everything this program will ever put on stdout that is not relayed bytes.
///
/// `exit 0` rather than a failure code: Chrome treats a non-zero exit as a
/// crashed host and logs it as one, when the actual situation — the desktop app
/// is not running — is ordinary and the extension already knows how to wait.
const UNAVAILABLE: &str = r#"{"type":"atlarix:bridge-unavailable"}"#;

fn main() {
    let socket = match socket_path() {
        Some(path) => path,
        None => {
            eprintln!(
                "atlarix-bridge: no socket path. Pass --socket <path> or set \
                 ATLARIX_BRIDGE_SOCKET. The wrapper in ~/.atlarix/chrome/ \
                 normally supplies this from host.env."
            );
            emit(UNAVAILABLE);
            return;
        }
    };

    let (mut from_app, mut to_app) = match connect(&socket) {
        Ok(pair) => pair,
        Err(err) => {
            // The ordinary case, not an error: the user has the extension
            // installed and the desktop app closed. Said on stderr for anyone
            // reading the browser's log, and answered on stdout so the
            // extension can back off rather than retry in a tight loop.
            eprintln!("atlarix-bridge: {socket} is not accepting connections ({err})");
            emit(UNAVAILABLE);
            return;
        }
    };

    // Chrome -> desktop, on its own thread. This is the direction that carries
    // page snapshots, so it is the one that can be large.
    let pump_in = std::thread::spawn(move || {
        let stdin = io::stdin();
        pump(stdin.lock(), &mut to_app);
    });

    // desktop -> Chrome, on the main thread, so that when the app goes away
    // this process ends rather than lingering as an orphan holding a port open.
    {
        let stdout = io::stdout();
        pump(&mut from_app, stdout.lock());
    }

    // The app hung up. Chrome has already seen stdout close; waiting on the
    // other pump would block until Chrome closes stdin, which it does not do
    // promptly. Dropping out is the correct end of a relay.
    drop(pump_in);
}

/// `--socket <path>`, or `ATLARIX_BRIDGE_SOCKET`.
///
/// Chrome appends its own arguments when it spawns a host — the origin, and on
/// Windows a parent-window handle — so this scans for the flag rather than
/// indexing, which would read whatever Chrome happened to put in that position.
fn socket_path() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--socket" {
            return args.get(i + 1).cloned();
        }
        if let Some(rest) = args[i].strip_prefix("--socket=") {
            return Some(rest.to_string());
        }
        i += 1;
    }
    std::env::var("ATLARIX_BRIDGE_SOCKET").ok()
}

/// One framed message on stdout, flushed.
fn emit(message: &str) {
    let bytes = message.as_bytes();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    // NATIVE byte order, which is what the protocol specifies. Every platform
    // Chrome ships on is little-endian, so this is the same as to_le_bytes in
    // practice — spelled `ne` because that is what the contract says.
    let _ = out.write_all(&(bytes.len() as u32).to_ne_bytes());
    let _ = out.write_all(bytes);
    let _ = out.flush();
}

/// Copy until either end stops, flushing every chunk.
///
/// HAND-WRITTEN RATHER THAN `io::copy`, and the reason is the flush. Rust's
/// `io::stdout()` is a `LineWriter`: it holds bytes until it sees a newline.
/// Framed binary contains newlines only by coincidence, so `io::copy` into
/// stdout would stall a reply inside this process until some later message
/// happened to carry a `\n` — intermittent, unreproducible, and indisputably
/// our fault. Flushing per chunk removes the question.
fn pump<R: Read, W: Write>(mut reader: R, mut writer: W) {
    // 64 KB: comfortably more than a request, and large enough that a megabyte
    // snapshot is a handful of iterations rather than a hundred.
    let mut buf = [0u8; 64 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if writer.write_all(&buf[..n]).is_err() {
                    break;
                }
                if writer.flush().is_err() {
                    break;
                }
            }
            Err(ref e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// Connect to the desktop, and hand back a reader and a writer for it.
///
/// Two halves rather than one handle because the two directions run on
/// different threads. Both platforms give a `try_clone` that duplicates the
/// underlying descriptor, so the halves are independent objects over one
/// connection — which is what allows a read to be in flight while a write
/// happens.
#[cfg(unix)]
fn connect(path: &str) -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    use std::os::unix::net::UnixStream;
    let stream = UnixStream::connect(path)?;
    let read_half = stream.try_clone()?;
    Ok((Box::new(read_half), Box::new(stream)))
}

/// Windows has no unix sockets in std, so the desktop listens on a named pipe.
///
/// A named pipe opened read/write through `OpenOptions` is a byte stream in
/// both directions, which is all this needs — the framing is in the bytes, not
/// in the transport, so nothing here depends on message-mode pipe semantics.
#[cfg(windows)]
fn connect(path: &str) -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    use std::fs::OpenOptions;
    let pipe = OpenOptions::new().read(true).write(true).open(path)?;
    let read_half = pipe.try_clone()?;
    Ok((Box::new(read_half), Box::new(pipe)))
}
