use std::fs::File;
use std::path::Path;

pub fn lock_file_exclusive_nonblocking(file: &File) -> Result<(), String> {
    platform::lock_file_exclusive_nonblocking(file)
}

pub fn restrict_path_to_current_user(path: &Path) -> Result<(), String> {
    platform::restrict_path_to_current_user(path)
}

pub fn owning_pid_for_loopback_ipv4_port(port: u16) -> Option<u32> {
    platform::owning_pid_for_loopback_ipv4_port(port)
}

pub fn process_creation_timestamp(pid: u32) -> Option<u64> {
    platform::process_creation_timestamp(pid)
}

pub fn terminate_process_matching_creation_time(pid: u32, expected_creation: u64) -> bool {
    platform::terminate_process_matching_creation_time(pid, expected_creation)
}

#[cfg(windows)]
mod platform {
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, FALSE, FILETIME, HANDLE,
        HLOCAL,
    };
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, TerminateProcess,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    pub fn lock_file_exclusive_nonblocking(file: &File) -> Result<(), String> {
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        let locked = unsafe {
            LockFileEx(
                file.as_raw_handle() as HANDLE,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        };
        if locked == 0 {
            return Err(
                "Another EasyEmail desktop instance is already using this data directory."
                    .to_string(),
            );
        }
        Ok(())
    }

    fn current_user_sid_string() -> Result<String, String> {
        let mut token: HANDLE = null_mut();
        let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
        if opened == 0 {
            return Err("Could not open current process token for file ACL.".to_string());
        }

        let result = (|| {
            let mut needed: u32 = 0;
            unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed) };
            if needed == 0 {
                return Err("Could not query current user token size.".to_string());
            }
            let mut buffer = vec![0u8; needed as usize];
            let ok = unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    needed,
                    &mut needed,
                )
            };
            if ok == 0 {
                return Err("Could not read current user SID.".to_string());
            }
            let token_user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
            let mut sid_wide: *mut u16 = null_mut();
            let converted = unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut sid_wide) };
            if converted == 0 || sid_wide.is_null() {
                return Err("Could not format current user SID.".to_string());
            }
            let mut len = 0usize;
            while unsafe { *sid_wide.add(len) } != 0 {
                len += 1;
            }
            let slice = unsafe { std::slice::from_raw_parts(sid_wide, len) };
            let sid = String::from_utf16_lossy(slice);
            unsafe { LocalFree(sid_wide as HLOCAL) };
            Ok(sid)
        })();

        unsafe { CloseHandle(token) };
        result
    }

    pub fn restrict_path_to_current_user(path: &Path) -> Result<(), String> {
        let sid = current_user_sid_string()?;
        let sddl = format!("D:P(A;;FA;;;{sid})");
        let sddl_wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut sd: PSECURITY_DESCRIPTOR = null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl_wide.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                null_mut(),
            )
        };
        if ok == 0 || sd.is_null() {
            return Err("Could not build user-only security descriptor.".to_string());
        }

        let apply_result = (|| {
            let mut dacl_present = FALSE;
            let mut dacl_defaulted = FALSE;
            let mut dacl: *mut ACL = null_mut();
            let got_dacl = unsafe {
                GetSecurityDescriptorDacl(sd, &mut dacl_present, &mut dacl, &mut dacl_defaulted)
            };
            if got_dacl == 0 || dacl_present == FALSE || dacl.is_null() {
                return Err(
                    "Could not extract DACL from user-only security descriptor.".to_string()
                );
            }
            let wide_path: Vec<u16> = path
                .as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let status = unsafe {
                SetNamedSecurityInfoW(
                    wide_path.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    dacl,
                    null(),
                )
            };
            if status != ERROR_SUCCESS {
                return Err(format!(
                    "Could not apply user-only file ACL (error {status})."
                ));
            }
            Ok(())
        })();

        unsafe { LocalFree(sd as HLOCAL) };
        apply_result
    }

    pub fn owning_pid_for_loopback_ipv4_port(port: u16) -> Option<u32> {
        let mut size: u32 = 0;
        let first = unsafe {
            GetExtendedTcpTable(
                null_mut(),
                &mut size,
                FALSE,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if first != ERROR_INSUFFICIENT_BUFFER || size == 0 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        let second = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut size,
                FALSE,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if second != ERROR_SUCCESS {
            return None;
        }
        let table = unsafe { &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
        let count = table.dwNumEntries as usize;
        let rows_ptr = table.table.as_ptr();
        let rows = unsafe { std::slice::from_raw_parts::<MIB_TCPROW_OWNER_PID>(rows_ptr, count) };
        let loopback = u32::from_ne_bytes([127, 0, 0, 1]);
        let wildcard = 0u32;
        for row in rows {
            let local_port = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
            if local_port == port && (row.dwLocalAddr == loopback || row.dwLocalAddr == wildcard) {
                return Some(row.dwOwningPid);
            }
        }
        None
    }

    fn filetime_to_u64(ft: FILETIME) -> u64 {
        ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
    }

    pub fn process_creation_timestamp(pid: u32) -> Option<u64> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) };
        if handle.is_null() {
            return None;
        }
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let mut exited: FILETIME = unsafe { std::mem::zeroed() };
        let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
        let mut user: FILETIME = unsafe { std::mem::zeroed() };
        let ok =
            unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
        unsafe { CloseHandle(handle) };
        if ok == 0 {
            None
        } else {
            Some(filetime_to_u64(created))
        }
    }

    pub fn terminate_process_matching_creation_time(pid: u32, expected_creation: u64) -> bool {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                FALSE,
                pid,
            )
        };
        if handle.is_null() {
            return false;
        }
        let mut created: FILETIME = unsafe { std::mem::zeroed() };
        let mut exited: FILETIME = unsafe { std::mem::zeroed() };
        let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
        let mut user: FILETIME = unsafe { std::mem::zeroed() };
        let times_ok =
            unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
        let terminated = if times_ok != 0 && filetime_to_u64(created) == expected_creation {
            unsafe { TerminateProcess(handle, 1) != 0 }
        } else {
            false
        };
        unsafe { CloseHandle(handle) };
        terminated
    }
}

#[cfg(not(windows))]
mod platform {
    use std::fs::File;
    use std::path::Path;

    pub fn lock_file_exclusive_nonblocking(_file: &File) -> Result<(), String> {
        Ok(())
    }

    pub fn restrict_path_to_current_user(path: &Path) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|err| format!("Could not apply 0600 file permissions: {err}"))?;
        }
        Ok(())
    }

    pub fn owning_pid_for_loopback_ipv4_port(_port: u16) -> Option<u32> {
        None
    }

    pub fn process_creation_timestamp(_pid: u32) -> Option<u64> {
        None
    }

    pub fn terminate_process_matching_creation_time(_pid: u32, _expected_creation: u64) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::net::TcpListener;

    #[test]
    fn restricts_temp_file_permissions_to_current_user() {
        let path =
            std::env::temp_dir().join(format!("easyemail-acl-test-{}.txt", uuid::Uuid::new_v4()));
        fs::write(&path, "sensitive-config").unwrap();
        restrict_path_to_current_user(&path).expect("apply user-only ACL");
        let _ = fs::remove_file(&path);
    }

    #[cfg(windows)]
    #[test]
    fn resolves_current_pid_and_creation_timestamp_for_loopback_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(
            owning_pid_for_loopback_ipv4_port(port),
            Some(std::process::id())
        );
        let created = process_creation_timestamp(std::process::id());
        assert!(created.is_some_and(|ts| ts > 0));
    }
}
