use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

const MAX_ACTIVE_CONNECTIONS: usize = 16;
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(20);

pub(super) fn run_bounded_server<F>(
    listener: TcpListener,
    shutdown: Arc<AtomicBool>,
    handle_connection: F,
) where
    F: Fn(TcpStream) + Send + Sync + 'static,
{
    let handle_connection = Arc::new(handle_connection);
    let mut workers = Vec::new();

    while !shutdown.load(Ordering::Acquire) {
        reap_finished(&mut workers);
        match listener.accept() {
            Ok((stream, _)) => {
                if shutdown.load(Ordering::Acquire) {
                    break;
                }
                if workers.len() >= MAX_ACTIVE_CONNECTIONS {
                    drop(stream);
                    continue;
                }
                let worker_handler = Arc::clone(&handle_connection);
                if let Ok(worker) = thread::Builder::new()
                    .name("easyemail-credential-client".to_string())
                    .spawn(move || worker_handler(stream))
                {
                    workers.push(worker);
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(_) => break,
        }
    }

    for worker in workers {
        let _ = worker.join();
    }
}

fn reap_finished(workers: &mut Vec<JoinHandle<()>>) {
    let mut index = 0;
    while index < workers.len() {
        if workers[index].is_finished() {
            let worker = workers.swap_remove(index);
            let _ = worker.join();
        } else {
            index += 1;
        }
    }
}
