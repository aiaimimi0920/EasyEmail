// Intentionally never becomes ready. The desktop responsiveness smoke uses this
// process to prove that a slow core cannot block the Tauri window message loop.
setInterval(() => {}, 1_000);
