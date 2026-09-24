use std::sync::atomic::{AtomicU64, Ordering};

/// A new user decision invalidates work started under the previous decision.
/// The low bit is the desired state; the other bits identify the decision.
#[derive(Default)]
pub struct ConnectionIntent(AtomicU64);

impl ConnectionIntent {
    pub fn set_enabled(&self, enabled: bool) {
        self.0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                Some((value.wrapping_add(2) & !1) | u64::from(enabled))
            })
            .unwrap();
    }

    pub fn token(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    pub fn enabled(&self) -> bool {
        self.token() & 1 == 1
    }

    pub fn allows(&self, token: u64) -> bool {
        token & 1 == 1 && token == self.token()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_and_restart_do_not_revive_old_work() {
        let intent = ConnectionIntent::default();
        assert!(!intent.enabled());
        intent.set_enabled(true);
        let first = intent.token();
        assert!(intent.allows(first));
        intent.set_enabled(false);
        assert!(!intent.allows(first));
        intent.set_enabled(true);
        assert!(intent.enabled());
        assert!(!intent.allows(first));
        assert!(intent.allows(intent.token()));
    }
}
