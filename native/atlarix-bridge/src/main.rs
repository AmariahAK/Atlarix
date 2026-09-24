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
/// ══ OPENED OVERLAPPED, AND THAT IS THE WHOLE FIX FOR v14.52.1 ══
///
/// This used to be `OpenOptions::new().read(true).write(true).open(path)` plus
/// `try_clone()`. On Windows that is a SYNCHRONOUS handle, and synchronous I/O
/// on one file object is serialized by the kernel — `try_clone` duplicates the
/// handle, not the file object. So the main thread's blocking `ReadFile`
/// (waiting for the desktop to speak) held the object while the stdin thread's
/// `WriteFile` (the extension's hello) queued behind it, forever. The desktop
/// never heard the hello, never marked the browser connected, and never spoke
/// first: a deadlock by construction, invisible on macOS/Linux where a socket's
/// two directions are independent. Measured on Windows 11 (UTM, ARM64), 2026-09-25.
///
/// With `FILE_FLAG_OVERLAPPED` each direction issues its own I/O with its own
/// `OVERLAPPED` and event and waits on that, so a pending read and a write can
/// be in flight at once — which is what "two independent halves" needs.
///
/// Hand-written FFI rather than the `windows` crate: this crate has no
/// dependencies on purpose (see Cargo.toml), and seven kernel32 calls do not
/// change that trade.
#[cfg(windows)]
fn connect(path: &str) -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    let pipe = std::sync::Arc::new(win::Pipe::open(path)?);
    Ok((
        Box::new(win::Half::new(pipe.clone())?),
        Box::new(win::Half::new(pipe)?),
    ))
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::io::{self, Read, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::sync::Arc;

    type Handle = *mut c_void;

    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    const ERROR_BROKEN_PIPE: i32 = 109;
    const ERROR_MORE_DATA: i32 = 234;
    const ERROR_PIPE_NOT_CONNECTED: i32 = 233;
    const ERROR_IO_PENDING: i32 = 997;

    fn invalid(h: Handle) -> bool {
        h.is_null() || h as isize == -1
    }

    /// `OVERLAPPED`. `Offset`/`OffsetHigh` share a union with `Pointer`; two
    /// u32s are the same size and alignment on every Windows target.
    #[repr(C)]
    pub(super) struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            disposition: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn CreateEventW(security: *mut c_void, manual: i32, initial: i32, name: *const u16) -> Handle;
        fn ReadFile(h: Handle, buf: *mut u8, len: u32, read: *mut u32, ov: *mut Overlapped) -> i32;
        fn WriteFile(h: Handle, buf: *const u8, len: u32, written: *mut u32, ov: *mut Overlapped) -> i32;
        fn GetOverlappedResult(h: Handle, ov: *mut Overlapped, n: *mut u32, wait: i32) -> i32;
        fn CloseHandle(h: Handle) -> i32;
    }

    /// The pipe handle, shared by both halves and closed once.
    pub struct Pipe(Handle);
    // The handle is only ever used through overlapped calls, each with its own
    // OVERLAPPED, which Windows explicitly allows from several threads at once.
    unsafe impl Send for Pipe {}
    unsafe impl Sync for Pipe {}

    impl Pipe {
        pub fn open(path: &str) -> io::Result<Pipe> {
            let wide: Vec<u16> = std::ffi::OsStr::new(path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let h = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null_mut(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    std::ptr::null_mut(),
                )
            };
            if invalid(h) {
                return Err(io::Error::last_os_error());
            }
            Ok(Pipe(h))
        }
    }

    impl Drop for Pipe {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// One direction: its own event, its own OVERLAPPED per call.
    pub struct Half {
        pipe: Arc<Pipe>,
        event: Handle,
    }
    unsafe impl Send for Half {}

    impl Half {
        pub fn new(pipe: Arc<Pipe>) -> io::Result<Half> {
            // Manual-reset: GetOverlappedResult(wait=TRUE) waits on it, and a
            // fresh OVERLAPPED per call resets it via ReadFile/WriteFile.
            let event = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, std::ptr::null()) };
            if invalid(event) {
                return Err(io::Error::last_os_error());
            }
            Ok(Half { pipe, event })
        }

        fn overlapped(&self) -> Overlapped {
            Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event: self.event,
            }
        }

        /// Finish an overlapped call: pending → wait for it; a closed pipe → 0.
        fn complete(&self, ok: i32, ov: &mut Overlapped) -> io::Result<usize> {
            if ok == 0 {
                let err = io::Error::last_os_error();
                match err.raw_os_error() {
                    Some(ERROR_IO_PENDING) => {}
                    Some(ERROR_BROKEN_PIPE) | Some(ERROR_PIPE_NOT_CONNECTED) => return Ok(0),
                    Some(ERROR_MORE_DATA) => {}
                    _ => return Err(err),
                }
            }
            let mut n: u32 = 0;
            let done = unsafe { GetOverlappedResult(self.pipe.0, ov, &mut n, 1) };
            if done == 0 {
                let err = io::Error::last_os_error();
                return match err.raw_os_error() {
                    Some(ERROR_BROKEN_PIPE) | Some(ERROR_PIPE_NOT_CONNECTED) => Ok(0),
                    Some(ERROR_MORE_DATA) => Ok(n as usize),
                    _ => Err(err),
                };
            }
            Ok(n as usize)
        }
    }

    impl Drop for Half {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.event);
            }
        }
    }

    impl Read for Half {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut ov = self.overlapped();
            let len = buf.len().min(u32::MAX as usize) as u32;
            let ok = unsafe {
                ReadFile(self.pipe.0, buf.as_mut_ptr(), len, std::ptr::null_mut(), &mut ov)
            };
            self.complete(ok, &mut ov)
        }
    }

    impl Write for Half {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let mut ov = self.overlapped();
            let len = buf.len().min(u32::MAX as usize) as u32;
            let ok = unsafe {
                WriteFile(self.pipe.0, buf.as_ptr(), len, std::ptr::null_mut(), &mut ov)
            };
            match self.complete(ok, &mut ov)? {
                0 if !buf.is_empty() => Err(io::Error::from(io::ErrorKind::BrokenPipe)),
                n => Ok(n),
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            // Writes complete before `write` returns; there is no buffer here.
            Ok(())
        }
    }
}

/// The deadlock this file used to have, as a test: a read pending on one half
/// while the other half writes. With the old synchronous handle the write never
/// returns. Runs on the Windows release runner (`cargo test` in build-windows).
#[cfg(all(test, windows))]
mod windows_pipe_tests {
    use super::connect;
    use super::win::Overlapped;
    use std::ffi::c_void;
    use std::io::{Read, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::sync::mpsc;
    use std::time::Duration;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateNamedPipeW(
            name: *const u16,
            open_mode: u32,
            pipe_mode: u32,
            max_instances: u32,
            out_size: u32,
            in_size: u32,
            timeout: u32,
            security: *mut c_void,
        ) -> *mut c_void;
        fn ConnectNamedPipe(h: *mut c_void, ov: *mut c_void) -> i32;
        fn ReadFile(h: *mut c_void, buf: *mut u8, len: u32, read: *mut u32, ov: *mut Overlapped) -> i32;
        fn WriteFile(h: *mut c_void, buf: *const u8, len: u32, w: *mut u32, ov: *mut Overlapped) -> i32;
    }

    struct Raw(*mut c_void);
    unsafe impl Send for Raw {}

    #[test]
    fn a_pending_read_does_not_block_a_write() {
        // A space in the name, like the "Amariah Abishai" pipe that found this.
        let name = format!(r"\\.\pipe\atlarix-bridge-test {}", std::process::id());
        let wide: Vec<u16> = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // PIPE_ACCESS_DUPLEX, byte mode, like libuv's server.
        let server = unsafe {
            CreateNamedPipeW(wide.as_ptr(), 3, 0, 1, 65536, 65536, 0, std::ptr::null_mut())
        };
        assert!(!server.is_null() && server as isize != -1, "server pipe");
        let server = Raw(server);

        let (tx, rx) = mpsc::channel();
        let serve = std::thread::spawn(move || {
            let server = server;
            unsafe { ConnectNamedPipe(server.0, std::ptr::null_mut()) };
            // The desktop's side: wait for the hello BEFORE saying anything.
            let mut buf = [0u8; 5];
            let mut n = 0u32;
            unsafe { ReadFile(server.0, buf.as_mut_ptr(), 5, &mut n, std::ptr::null_mut::<Overlapped>()) };
            tx.send(buf[..n as usize].to_vec()).unwrap();
            let mut w = 0u32;
            unsafe { WriteFile(server.0, b"reply".as_ptr(), 5, &mut w, std::ptr::null_mut::<Overlapped>()) };
            server
        });

        std::thread::sleep(Duration::from_millis(100));
        let (mut reader, mut writer) = connect(&name).expect("connect");

        // Read pending first — exactly the relay's main thread.
        let read = std::thread::spawn(move || {
            let mut buf = [0u8; 5];
            let n = reader.read(&mut buf).unwrap();
            buf[..n].to_vec()
        });
        std::thread::sleep(Duration::from_millis(100));

        writer.write_all(b"hello").unwrap();
        let heard = rx.recv_timeout(Duration::from_secs(5)).expect(
            "the write never reached the server: the pending read blocked it (the v14.52.0 deadlock)",
        );
        assert_eq!(heard, b"hello");
        assert_eq!(read.join().unwrap(), b"reply");
        drop(serve.join());
    }
}
