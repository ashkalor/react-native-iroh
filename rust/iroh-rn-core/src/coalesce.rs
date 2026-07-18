//! Native-side coalescing of progress events.
//!
//! The core emits one progress value per transfer chunk, far more than JS
//! can usefully render. A [`Coalescer`] rate-limits that stream *before* it
//! crosses the bridge: the first value passes through immediately, later
//! values are suppressed until `min_interval` has elapsed, and the most
//! recent suppressed value can be [`flush`](Coalescer::flush)ed so the last
//! progress state always reaches JS before the terminal event.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

/// Rate-limits a stream of cumulative progress values to at most one emission
/// per `min_interval`, always keeping the newest value available for a final
/// flush. Values are expected to be non-decreasing (cumulative bytes).
pub(crate) struct Coalescer<F: Fn(u64) + Send + Sync> {
    min_interval: Duration,
    sink: F,
    state: Mutex<State>,
}

struct State {
    last_emit: Option<Instant>,
    pending: Option<u64>,
}

impl<F: Fn(u64) + Send + Sync> Coalescer<F> {
    /// Creates a coalescer that forwards emitted values to `sink`.
    pub(crate) fn new(min_interval: Duration, sink: F) -> Self {
        Self {
            min_interval,
            sink,
            state: Mutex::new(State {
                last_emit: None,
                pending: None,
            }),
        }
    }

    /// Offers a new cumulative value. Emits it if this is the first value or
    /// `min_interval` has elapsed since the last emission; otherwise records
    /// it as pending (replacing any older pending value).
    pub(crate) fn offer(&self, value: u64) {
        self.offer_at(value, Instant::now());
    }

    /// Emits the most recent suppressed value, if any. Called once before the
    /// terminal event so JS always observes the final progress state.
    pub(crate) fn flush(&self) {
        let pending = {
            let mut state = self.lock();
            let pending = state.pending.take();
            if pending.is_some() {
                state.last_emit = Some(Instant::now());
            }
            pending
        };
        if let Some(value) = pending {
            (self.sink)(value);
        }
    }

    fn offer_at(&self, value: u64, now: Instant) {
        let emit = {
            let mut state = self.lock();
            let due = match state.last_emit {
                None => true,
                Some(last) => now.duration_since(last) >= self.min_interval,
            };
            if due {
                state.last_emit = Some(now);
                state.pending = None;
            } else {
                state.pending = Some(value);
            }
            due
        };
        // The sink runs outside the lock: it crosses into the C++ bridge and
        // must never be able to deadlock against offer()/flush() callers.
        if emit {
            (self.sink)(value);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    const INTERVAL: Duration = Duration::from_millis(34);

    fn collector() -> (Arc<Mutex<Vec<u64>>>, impl Fn(u64) + Send + Sync) {
        let seen: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        (seen, move |value| sink_seen.lock().unwrap().push(value))
    }

    #[test]
    fn first_value_is_emitted_immediately() {
        let (seen, sink) = collector();
        let coalescer = Coalescer::new(INTERVAL, sink);
        coalescer.offer_at(10, Instant::now());
        assert_eq!(*seen.lock().unwrap(), vec![10]);
    }

    #[test]
    fn values_within_interval_are_suppressed_and_flush_emits_newest() {
        let (seen, sink) = collector();
        let coalescer = Coalescer::new(INTERVAL, sink);
        let t0 = Instant::now();
        coalescer.offer_at(1, t0);
        coalescer.offer_at(2, t0 + Duration::from_millis(1));
        coalescer.offer_at(3, t0 + Duration::from_millis(2));
        assert_eq!(*seen.lock().unwrap(), vec![1]);
        coalescer.flush();
        assert_eq!(*seen.lock().unwrap(), vec![1, 3]);
    }

    #[test]
    fn value_after_interval_is_emitted_and_clears_pending() {
        let (seen, sink) = collector();
        let coalescer = Coalescer::new(INTERVAL, sink);
        let t0 = Instant::now();
        coalescer.offer_at(1, t0);
        coalescer.offer_at(2, t0 + Duration::from_millis(1));
        coalescer.offer_at(3, t0 + INTERVAL);
        assert_eq!(*seen.lock().unwrap(), vec![1, 3]);
        // The suppressed `2` was superseded by the emitted `3`.
        coalescer.flush();
        assert_eq!(*seen.lock().unwrap(), vec![1, 3]);
    }

    #[test]
    fn flush_without_pending_emits_nothing() {
        let (seen, sink) = collector();
        let coalescer = Coalescer::new(INTERVAL, sink);
        coalescer.flush();
        coalescer.offer_at(1, Instant::now());
        coalescer.flush();
        assert_eq!(*seen.lock().unwrap(), vec![1]);
    }

    #[test]
    fn emission_rate_is_bounded_by_interval() {
        let (seen, sink) = collector();
        let coalescer = Coalescer::new(INTERVAL, sink);
        let t0 = Instant::now();
        // 1000 rapid-fire events over one simulated second.
        for i in 0..1000u64 {
            coalescer.offer_at(i, t0 + Duration::from_millis(i));
        }
        let count = seen.lock().unwrap().len();
        // ceil(1000 / 34) = 30 emissions at most for one second of events.
        assert!(count <= 30, "emitted {count} events for 1s of input");
        assert!(count >= 25, "coalescer is dropping too much: {count}");
        // Emitted values are non-decreasing.
        let seen = seen.lock().unwrap();
        assert!(seen.windows(2).all(|pair| pair[0] <= pair[1]));
    }
}
