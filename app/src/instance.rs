//! A single ORQEN window: a second `orqen` sends its folder to the running app (a new tab) and exits.
//! The running app listens on 127.0.0.1 (random port written to ~/.orqen/app.port).
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::state;

const HELLO: &str = "orqen-app/1";

/// true if another instance took the folder.
pub fn forward(repo: &PathBuf) -> bool {
    let Ok(port) = std::fs::read_to_string(state::dir().join("app.port")) else { return false };
    let Ok(addr) = format!("127.0.0.1:{}", port.trim()).parse::<SocketAddr>() else { return false };
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    if writeln!(s, "{HELLO} {}", repo.display()).is_err() { return false; }
    let mut answer = String::new();
    BufReader::new(s).read_line(&mut answer).is_ok() && answer.trim() == "ok"
}

/// Starts listening; folders that arrive are pushed to `inbox` (the window picks them up).
pub fn listen(inbox: Arc<Mutex<Vec<PathBuf>>>) {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(addr) = listener.local_addr() else { return };
    let _ = std::fs::create_dir_all(state::dir());
    let _ = std::fs::write(state::dir().join("app.port"), addr.port().to_string());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut line = String::new();
            let mut reader = BufReader::new(&stream);
            if reader.read_line(&mut line).is_err() { continue; }
            if let Some(path) = line.trim().strip_prefix(HELLO).map(str::trim).filter(|p| !p.is_empty()) {
                inbox.lock().unwrap().push(PathBuf::from(path));
                let _ = (&stream).write_all(b"ok\n");
            }
        }
    });
}
