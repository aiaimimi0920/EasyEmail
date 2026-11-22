use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use zeroize::Zeroizing;

const MAX_HEADER_BYTES: usize = 8192;
const MAX_BODY_BYTES: usize = 16_384;

pub(super) struct ParsedBrokerHttpRequest {
    pub(super) buffer: Zeroizing<Vec<u8>>,
    pub(super) body_offset: usize,
    pub(super) method: String,
    pub(super) path: String,
    pub(super) authorization: Option<String>,
}

pub(super) fn constant_time_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

pub(super) fn parse_content_length(header: &str) -> Result<usize, ()> {
    let mut content_length = None;
    for line in header.lines().skip(1) {
        let (name, value) = line.split_once(':').ok_or(())?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(());
        }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(());
            }
            content_length = Some(value.trim().parse::<usize>().map_err(|_| ())?);
        }
    }
    content_length.ok_or(())
}

fn parse_authorization(header: &str) -> Result<Option<String>, ()> {
    let mut authorization = None;
    for line in header.lines().skip(1) {
        let (name, value) = line.split_once(':').ok_or(())?;
        if name.eq_ignore_ascii_case("authorization") {
            if authorization.is_some() {
                return Err(());
            }
            authorization = Some(value.trim().to_string());
        }
    }
    Ok(authorization)
}

fn read_raw_request(stream: &mut TcpStream, timeout: Duration) -> Result<Zeroizing<Vec<u8>>, ()> {
    stream.set_read_timeout(Some(timeout)).map_err(|_| ())?;
    stream.set_write_timeout(Some(timeout)).map_err(|_| ())?;
    let mut buffer = Zeroizing::new(Vec::with_capacity(2048));
    let (header_end, content_length) = loop {
        if let Some(header_end) = find_header_end(&buffer) {
            if header_end > MAX_HEADER_BYTES {
                return Err(());
            }
            let header = std::str::from_utf8(&buffer[..header_end]).map_err(|_| ())?;
            let content_length = parse_content_length(header)?;
            if content_length > MAX_BODY_BYTES {
                return Err(());
            }
            break (header_end, content_length);
        }
        if buffer.len() > MAX_HEADER_BYTES {
            return Err(());
        }
        let mut chunk = [0_u8; 2048];
        let read = stream.read(&mut chunk).map_err(|_| ())?;
        if read == 0 {
            return Err(());
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let expected_length = header_end + 4 + content_length;
    while buffer.len() < expected_length {
        let mut chunk = [0_u8; 2048];
        let read = stream.read(&mut chunk).map_err(|_| ())?;
        if read == 0 || buffer.len() + read > MAX_HEADER_BYTES + 4 + MAX_BODY_BYTES {
            return Err(());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    buffer.truncate(expected_length);
    Ok(buffer)
}

pub(super) fn read_broker_http_request(
    stream: &mut TcpStream,
    timeout: Duration,
) -> Result<ParsedBrokerHttpRequest, ()> {
    let buffer = read_raw_request(stream, timeout)?;
    let header_end = find_header_end(&buffer).ok_or(())?;
    let header = std::str::from_utf8(&buffer[..header_end]).map_err(|_| ())?;
    let mut lines = header.lines();
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let path = request_line.next().unwrap_or_default().to_string();
    let version = request_line.next().unwrap_or_default();
    if request_line.next().is_some() || version != "HTTP/1.1" {
        return Err(());
    }
    let authorization = parse_authorization(header)?;
    Ok(ParsedBrokerHttpRequest {
        buffer,
        body_offset: header_end + 4,
        method,
        path,
        authorization,
    })
}

pub(super) fn write_error(stream: &mut TcpStream, status: u16, code: &str) {
    let body = format!(r#"{{"status":"error","code":"{code}"}}"#);
    write_json(stream, status, body.as_bytes());
}

pub(super) fn write_json(stream: &mut TcpStream, status: u16, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Service Unavailable",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}
