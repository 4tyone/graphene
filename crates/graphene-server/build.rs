//! Stamp the build time in, so the running server can say which binary it is.
//!
//! The UI is compiled into the binary, so "the fix is not working" and "you are
//! running yesterday's build" look identical from a browser. This makes them
//! distinguishable.

fn main() {
    println!("cargo:rerun-if-changed=../../ui");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=GRAPHENE_BUILT={now}");
}
