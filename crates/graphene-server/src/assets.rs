//! The UI, compiled into the binary.
//!
//! One file to ship, no npm, and **no network at build or runtime** — which is
//! also why the DAG layout is hand-written rather than pulled from a package.

use axum::extract::Path;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../../ui/"]
struct Ui;

pub(crate) async fn index(headers: HeaderMap) -> Response {
    serve("index.html", &headers)
}

pub(crate) async fn asset(Path(path): Path<String>, headers: HeaderMap) -> Response {
    serve(&path, &headers)
}

fn serve(path: &str, headers: &HeaderMap) -> Response {
    match Ui::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            // The UI is compiled in, so a cached asset can outlive the rebuild
            // that changed it — which looks exactly like a fix that did not
            // work. `no-cache` still lets the browser keep the bytes; it just
            // has to ask, and the hash answers in one round trip.
            let etag = format!("\"{}\"", hex(&file.metadata.sha256_hash()));

            // An ETag nothing checks is decoration. Answer the revalidation.
            if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(&etag) {
                return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag.as_str())]).into_response();
            }

            (
                [
                    (header::CONTENT_TYPE, mime.as_ref()),
                    (header::CACHE_CONTROL, "no-cache"),
                    (header::ETAG, etag.as_str()),
                ],
                file.data.into_owned(),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
