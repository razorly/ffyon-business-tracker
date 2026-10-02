use std::time::Duration;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::access::AccessState;

const POSTCODE_ORIGIN: &str = "https://api.postcodes.io";
const DIRECTIONS_URL: &str = "https://www.google.com/maps/dir/";
const MAX_RESPONSE_BYTES: usize = 65_536;

#[derive(Serialize)]
pub struct PostcodeLocation {
    postcode: String,
    latitude: f64,
    longitude: f64,
}

#[derive(Deserialize)]
struct PostcodeResponse {
    status: u16,
    result: Option<PostcodeResult>,
}

#[derive(Deserialize)]
struct PostcodeResult {
    postcode: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

fn normalize_postcode(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.len() > 16
        || !input
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b' ')
    {
        return Err("Enter a valid UK postcode".into());
    }
    let compact: String = input
        .bytes()
        .filter(|byte| *byte != b' ')
        .map(|byte| char::from(byte.to_ascii_uppercase()))
        .collect();
    if !(5..=7).contains(&compact.len()) {
        return Err("Enter a valid UK postcode".into());
    }
    let split = compact.len() - 3;
    let (outward, inward) = compact.split_at(split);
    let outward = outward.as_bytes();
    let inward = inward.as_bytes();
    let prefix = outward
        .iter()
        .take_while(|byte| byte.is_ascii_uppercase())
        .count();
    let standard = (1..=2).contains(&prefix)
        && outward.get(prefix).is_some_and(u8::is_ascii_digit)
        && outward.len() - prefix <= 2;
    if compact != "GIR0AA"
        && (!standard
            || !inward[0].is_ascii_digit()
            || !inward[1..].iter().all(u8::is_ascii_uppercase))
    {
        return Err("Enter a valid UK postcode".into());
    }
    Ok(format!("{} {}", &compact[..split], &compact[split..]))
}

fn postcode_url(postcode: &str) -> Result<Url, String> {
    let mut url = Url::parse(POSTCODE_ORIGIN).map_err(|_| "Postcode lookup is unavailable")?;
    url.path_segments_mut()
        .map_err(|_| "Postcode lookup is unavailable")?
        .extend(["postcodes", postcode]);
    Ok(url)
}

fn parse_location(bytes: &[u8], requested: &str) -> Result<PostcodeLocation, String> {
    let response: PostcodeResponse = serde_json::from_slice(bytes)
        .map_err(|_| "The postcode lookup returned an invalid response")?;
    if response.status != 200 {
        return Err("That postcode could not be found".into());
    }
    let result = response.result.ok_or("That postcode could not be found")?;
    let postcode = normalize_postcode(&result.postcode)?;
    let latitude = result
        .latitude
        .ok_or("The postcode location is unavailable")?;
    let longitude = result
        .longitude
        .ok_or("The postcode location is unavailable")?;
    if postcode != requested
        || !latitude.is_finite()
        || !longitude.is_finite()
        || !(-90.0..=90.0).contains(&latitude)
        || !(-180.0..=180.0).contains(&longitude)
    {
        return Err("The postcode lookup returned an invalid location".into());
    }
    Ok(PostcodeLocation {
        postcode,
        latitude,
        longitude,
    })
}

#[tauri::command]
pub async fn lookup_postcode(
    access: State<'_, AccessState>,
    postcode: String,
) -> Result<PostcodeLocation, String> {
    access.require_authorized()?;
    let postcode = normalize_postcode(&postcode)?;
    // This client never receives the admin token or the appointment address.
    let client = Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(5))
        .user_agent(concat!("TannedByFfyBusinessTracker/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Postcode lookup is unavailable")?;
    access.require_authorized()?;
    let mut response = client
        .get(postcode_url(&postcode)?)
        .send()
        .await
        .map_err(|_| "Unable to reach the postcode lookup. Check your connection.")?;
    access.require_authorized()?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("That postcode could not be found".into());
    }
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Postcode lookup is unavailable. Try again later.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The postcode lookup could not be read")?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("The postcode lookup returned an invalid response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    access.require_authorized()?;
    parse_location(&bytes, &postcode)
}

fn directions_url(address: &str, postcode: &str) -> Result<Url, String> {
    let address = address.trim();
    if address.is_empty()
        || address.len() > 1_000
        || address
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err("Enter a valid appointment address".into());
    }
    let postcode = normalize_postcode(postcode)?;
    let address = address.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut url = Url::parse(DIRECTIONS_URL).map_err(|_| "Directions are unavailable")?;
    url.query_pairs_mut()
        .append_pair("api", "1")
        .append_pair("destination", &format!("{address}, {postcode}"));
    Ok(url)
}

#[cfg(target_os = "windows")]
fn open_browser(url: &Url) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            window: *mut std::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
    let operation: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let file: Vec<u16> = std::ffi::OsStr::new(url.as_str())
        .encode_wide()
        .chain(Some(0))
        .collect();
    // ShellExecute receives one already-validated HTTPS URL, never a shell command.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result > 32 {
        Ok(())
    } else {
        Err("The browser could not open directions".into())
    }
}

#[cfg(target_os = "macos")]
fn open_browser(url: &Url) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url.as_str())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| "The browser could not open directions")?;
    if status.success() {
        Ok(())
    } else {
        Err("The browser could not open directions".into())
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn open_browser(_url: &Url) -> Result<(), String> {
    Err("Directions are available on Windows and macOS".into())
}

#[tauri::command]
pub fn open_appointment_directions(
    access: State<'_, AccessState>,
    address: String,
    postcode: String,
) -> Result<(), String> {
    access.require_authorized()?;
    let url = directions_url(&address, &postcode)?;
    access.require_authorized()?;
    open_browser(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postcode_normalization_accepts_only_bounded_uk_shapes() {
        for (input, expected) in [
            (" sw1a 1aa ", "SW1A 1AA"),
            ("EC1A1BB", "EC1A 1BB"),
            ("M11AE", "M1 1AE"),
            ("B338TH", "B33 8TH"),
            ("CR26XH", "CR2 6XH"),
            ("DN551PT", "DN55 1PT"),
            ("GIR0AA", "GIR 0AA"),
        ] {
            assert_eq!(normalize_postcode(input).unwrap(), expected);
        }
        for input in [
            "",
            "https://evil.test",
            "SW1A/1AA",
            "SW1A1AA?key=secret",
            "123456",
            "SW1A\n1AA",
            "AAABC1DD",
            "SW1A 111",
            "\u{0000}SW1A1AA",
            "SW1A1A\u{00c5}",
        ] {
            assert!(normalize_postcode(input).is_err(), "{input}");
        }
    }

    #[test]
    fn postcode_lookup_cannot_change_the_provider_origin() {
        let postcode = normalize_postcode("SW1A1AA").unwrap();
        let url = postcode_url(&postcode).unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("api.postcodes.io"));
        assert_eq!(url.path(), "/postcodes/SW1A%201AA");
        assert!(url.query().is_none());
        assert!(url.username().is_empty());
    }

    #[test]
    fn response_must_match_postcode_and_contain_valid_coordinates() {
        let good = br#"{"status":200,"result":{"postcode":"SW1A 1AA","latitude":51.501,"longitude":-0.141}}"#;
        let found = parse_location(good, "SW1A 1AA").unwrap();
        assert_eq!(found.postcode, "SW1A 1AA");
        assert!(parse_location(good, "M1 1AE").is_err());
        assert!(parse_location(
            br#"{"status":200,"result":{"postcode":"SW1A 1AA","latitude":91,"longitude":0}}"#,
            "SW1A 1AA"
        )
        .is_err());
        assert!(parse_location(
            br#"{"status":200,"result":{"postcode":"SW1A 1AA","latitude":null,"longitude":0}}"#,
            "SW1A 1AA"
        )
        .is_err());
        assert!(parse_location(br#"{"status":404,"result":null}"#, "SW1A 1AA").is_err());
        assert!(parse_location(b"not json", "SW1A 1AA").is_err());
    }

    #[test]
    fn directions_only_opens_fixed_https_maps_with_escaped_destination() {
        let address = "12 Example Lane\n&api=0; file:///private";
        let url = directions_url(address, "SW1A1AA").unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("www.google.com"));
        assert_eq!(url.path(), "/maps/dir/");
        let pairs: Vec<_> = url.query_pairs().collect();
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0], ("api".into(), "1".into()));
        assert_eq!(pairs[1].0, "destination");
        assert_eq!(
            pairs[1].1,
            "12 Example Lane &api=0; file:///private, SW1A 1AA"
        );
        assert!(directions_url("", "SW1A1AA").is_err());
        assert!(directions_url("bad\0address", "SW1A1AA").is_err());
        assert!(directions_url(&"A".repeat(1_001), "SW1A1AA").is_err());
        assert!(directions_url("12 Lane", "https://evil.example").is_err());
    }
}
