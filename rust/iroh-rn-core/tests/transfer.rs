//! Integration test: two in-process endpoints (relay disabled) share a temp
//! file and download it, asserting BLAKE3 hash equality and progress
//! monotonicity with exactly one terminal event.
#![allow(non_snake_case)]

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

use Iroh_rust::{
    blobs::{blob_download, blob_share},
    endpoint::{
        endpoint_close, endpoint_create, endpoint_node_id, EndpointConfig, EndpointHandle,
        NetworkProfile,
    },
};

const TIMEOUT: Duration = Duration::from_secs(60);

/// Deterministic pseudo-random payload (xorshift), big enough to span many
/// chunk groups so the transfer emits multiple progress events.
fn payload(len: usize) -> Vec<u8> {
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        out.extend_from_slice(&state.to_le_bytes());
    }
    out.truncate(len);
    out
}

fn create_isolated_endpoint(store_dir: &Path) -> EndpointHandle {
    let (tx, rx) = mpsc::channel();
    endpoint_create(
        EndpointConfig {
            profile: NetworkProfile::Isolated,
            blob_store_dir: Some(store_dir.to_path_buf()),
        },
        move |result| {
            tx.send(result).ok();
        },
    );
    rx.recv_timeout(TIMEOUT)
        .expect("endpoint_create completion callback fired")
        .expect("endpoint created")
}

fn close_endpoint(handle: EndpointHandle) {
    let (tx, rx) = mpsc::channel();
    endpoint_close(handle, move |result| {
        tx.send(result).ok();
    });
    rx.recv_timeout(TIMEOUT)
        .expect("endpoint_close completion callback fired")
        .expect("endpoint closed");
}

#[test]
fn two_isolated_endpoints_transfer_a_file_with_monotone_progress() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bytes = payload(4 * 1024 * 1024);
    let src_path = dir.path().join("shared.bin");
    std::fs::write(&src_path, &bytes).expect("write source file");

    let provider = create_isolated_endpoint(&dir.path().join("provider-store"));
    let receiver = create_isolated_endpoint(&dir.path().join("receiver-store"));

    // Node ids are distinct, valid public keys.
    let provider_id = endpoint_node_id(provider).expect("provider node id");
    let receiver_id = endpoint_node_id(receiver).expect("receiver node id");
    assert_ne!(provider_id, receiver_id);
    provider_id
        .parse::<iroh::EndpointId>()
        .expect("node id parses as an iroh EndpointId");

    // Share: path -> ticket.
    let (share_tx, share_rx) = mpsc::channel();
    blob_share(provider, src_path.clone(), move |result| {
        share_tx.send(result).ok();
    });
    let ticket = share_rx
        .recv_timeout(TIMEOUT)
        .expect("share completion callback fired")
        .expect("share produced a ticket");
    assert!(!ticket.is_empty());

    // Download: ticket -> destination file, with progress events.
    let dest_path: PathBuf = dir.path().join("downloaded.bin");
    let progress: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
    let progress_sink = Arc::clone(&progress);
    let completions = Arc::new(AtomicUsize::new(0));
    let completions_sink = Arc::clone(&completions);
    let (done_tx, done_rx) = mpsc::channel();

    let _transfer = blob_download(
        receiver,
        &ticket,
        dest_path.clone(),
        move |transferred| {
            progress_sink.lock().unwrap().push(transferred);
        },
        move |result| {
            completions_sink.fetch_add(1, Ordering::SeqCst);
            done_tx.send(result).ok();
        },
    )
    .expect("download accepted");

    done_rx
        .recv_timeout(TIMEOUT)
        .expect("download completion callback fired")
        .expect("download succeeded");

    // Terminal event exactly once (give any stray duplicate a moment to land).
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(completions.load(Ordering::SeqCst), 1);

    // BLAKE3 hash equality between source and downloaded file.
    let downloaded = std::fs::read(&dest_path).expect("read downloaded file");
    assert_eq!(downloaded.len(), bytes.len());
    assert_eq!(blake3::hash(&downloaded), blake3::hash(&bytes));

    // Progress: at least one event, non-decreasing, never past the total.
    let progress = progress.lock().unwrap();
    assert!(!progress.is_empty(), "no progress events were emitted");
    for pair in progress.windows(2) {
        assert!(pair[0] <= pair[1], "progress regressed: {progress:?}");
    }
    assert!(*progress.last().unwrap() <= bytes.len() as u64);

    close_endpoint(provider);
    close_endpoint(receiver);
}
