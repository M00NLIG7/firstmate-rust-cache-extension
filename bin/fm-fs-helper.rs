use std::env;
use std::ffi::CString;
use std::io::Read;
use std::os::raw::{c_char, c_int};
use std::os::unix::io::{FromRawFd, RawFd};

#[repr(C)]
struct Stat {
    st_dev: u64,
    st_ino: u64,
    st_nlink: u64,
    st_mode: u32,
    st_uid: u32,
    st_gid: u32,
    st_rdev: u64,
    st_size: i64,
    st_blksize: i64,
    st_blocks: i64,
    st_atime: i64,
    st_atime_nsec: i64,
    st_mtime: i64,
    st_mtime_nsec: i64,
    st_ctime: i64,
    st_ctime_nsec: i64,
    __unused: [i64; 3],
}

extern "C" {
    fn close(fd: c_int) -> c_int;
    fn fstat(fd: c_int, stat: *mut Stat) -> c_int;
    fn open(path: *const c_char, flags: c_int) -> c_int;
    fn openat(fd: c_int, path: *const c_char, flags: c_int) -> c_int;
    fn unlinkat(fd: c_int, path: *const c_char, flags: c_int) -> c_int;
    fn rmdir(path: *const c_char) -> c_int;
    fn geteuid() -> u32;
}

#[cfg(target_os = "linux")]
const O_DIRECTORY: c_int = 0o200000;
#[cfg(target_os = "linux")]
const O_NOFOLLOW: c_int = 0o400000;
#[cfg(target_os = "macos")]
const O_DIRECTORY: c_int = 0x100000;
#[cfg(target_os = "macos")]
const O_NOFOLLOW: c_int = 0x100;
#[cfg(target_os = "linux")]
const AT_REMOVEDIR: c_int = 0x200;
#[cfg(target_os = "macos")]
const AT_REMOVEDIR: c_int = 0x80;
const O_RDONLY: c_int = 0;
const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;

fn cstring(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "NUL in path".to_string())
}

fn stat_fd(fd: RawFd) -> Result<Stat, String> {
    let mut value = Stat {
        st_dev: 0, st_ino: 0, st_nlink: 0, st_mode: 0, st_uid: 0, st_gid: 0, st_rdev: 0,
        st_size: 0, st_blksize: 0, st_blocks: 0, st_atime: 0, st_atime_nsec: 0,
        st_mtime: 0, st_mtime_nsec: 0, st_ctime: 0, st_ctime_nsec: 0, __unused: [0; 3],
    };
    if unsafe { fstat(fd, &mut value) } != 0 { return Err("fstat failed".to_string()); }
    Ok(value)
}

fn owned_directory(fd: RawFd) -> Result<Stat, String> {
    let value = stat_fd(fd)?;
    if value.st_mode & S_IFMT != S_IFDIR || value.st_uid != unsafe { geteuid() } || value.st_mode & 0o077 != 0 {
        return Err("unsafe directory".to_string());
    }
    Ok(value)
}

fn open_directory(path: &str) -> Result<RawFd, String> {
    if !path.starts_with('/') { return Err("absolute path required".to_string()); }
    let root = cstring("/")?;
    let mut fd = unsafe { open(root.as_ptr(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW) };
    if fd < 0 { return Err("cannot open root".to_string()); }
    for component in path.split('/').filter(|part| !part.is_empty()) {
        if component == "." || component == ".." { unsafe { close(fd); } return Err("unsafe path".to_string()); }
        let child = cstring(component)?;
        let next = unsafe { openat(fd, child.as_ptr(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW) };
        unsafe { close(fd); }
        if next < 0 { return Err("cannot open directory".to_string()); }
        fd = next;
    }
    owned_directory(fd)?;
    Ok(fd)
}

fn owner_matches(fd: RawFd, token: &str) -> Result<bool, String> {
    let name = cstring("owner.json")?;
    let owner = unsafe { openat(fd, name.as_ptr(), O_RDONLY | O_NOFOLLOW) };
    if owner < 0 { return Ok(false); }
    let result = (|| {
        let info = stat_fd(owner)?;
        if info.st_mode & S_IFMT != S_IFREG || info.st_uid != unsafe { geteuid() } || info.st_mode & 0o077 != 0 {
            return Ok(false);
        }
        let mut file = unsafe { std::fs::File::from_raw_fd(owner) };
        let mut contents = String::new();
        file.read_to_string(&mut contents).map_err(|_| "cannot read owner".to_string())?;
        std::mem::forget(file);
        Ok(contents.contains(&format!("\"token\":\"{}\"", token)))
    })();
    unsafe { close(owner); }
    result
}

fn release_lock(path: &str, device: &str, inode: &str, token: &str) -> Result<(), String> {
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return Err("invalid token".to_string());
    }
    let fd = open_directory(path)?;
    let result = (|| {
        let identity = owned_directory(fd)?;
        if identity.st_dev.to_string() != device || identity.st_ino.to_string() != inode || !owner_matches(fd, token)? {
            return Err("identity changed".to_string());
        }
        let name = cstring("owner.json")?;
        if unsafe { unlinkat(fd, name.as_ptr(), 0) } != 0 { return Err("cannot remove owner".to_string()); }
        let after = owned_directory(fd)?;
        if after.st_dev != identity.st_dev || after.st_ino != identity.st_ino { return Err("identity changed".to_string()); }
        #[cfg(target_os = "linux")]
        let pinned = format!("/proc/self/fd/{}", fd);
        #[cfg(target_os = "macos")]
        let pinned = format!("/dev/fd/{}", fd);
        let pinned = cstring(&pinned)?;
        if unsafe { rmdir(pinned.as_ptr()) } != 0 { return Err("cannot remove empty lock".to_string()); }
        Ok(())
    })();
    unsafe { close(fd); }
    result
}

fn pinned_path(fd: RawFd) -> String {
    #[cfg(target_os = "linux")]
    return format!("/proc/self/fd/{}", fd);
    #[cfg(target_os = "macos")]
    return format!("/dev/fd/{}", fd);
}

fn remove_tree_fd(fd: RawFd) -> Result<(), String> {
    let entries = std::fs::read_dir(pinned_path(fd)).map_err(|_| "cannot read directory".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "cannot read directory entry".to_string())?;
        let name = entry.file_name().into_string().map_err(|_| "invalid directory entry".to_string())?;
        if name == "." || name == ".." { return Err("invalid directory entry".to_string()); }
        let child = cstring(&name)?;
        let child_fd = unsafe { openat(fd, child.as_ptr(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW) };
        if child_fd >= 0 {
            let result = remove_tree_fd(child_fd);
            unsafe { close(child_fd); }
            result?;
            if unsafe { unlinkat(fd, child.as_ptr(), AT_REMOVEDIR) } != 0 {
                return Err("cannot remove child directory".to_string());
            }
        } else if unsafe { unlinkat(fd, child.as_ptr(), 0) } != 0 {
            return Err("cannot remove child entry".to_string());
        }
    }
    Ok(())
}

fn remove_tree(path: &str, device: &str, inode: &str) -> Result<(), String> {
    let fd = open_directory(path)?;
    let result = (|| {
        let identity = owned_directory(fd)?;
        if identity.st_dev.to_string() != device || identity.st_ino.to_string() != inode {
            return Err("identity changed".to_string());
        }
        remove_tree_fd(fd)?;
        let after = owned_directory(fd)?;
        if after.st_dev != identity.st_dev || after.st_ino != identity.st_ino { return Err("identity changed".to_string()); }
        let pinned = cstring(&pinned_path(fd))?;
        if unsafe { rmdir(pinned.as_ptr()) } != 0 { return Err("cannot remove directory".to_string()); }
        Ok(())
    })();
    unsafe { close(fd); }
    result
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let result = match args.as_slice() {
        [_, command] if command == "probe" => Ok(()),
        [_, command, path, device, inode, token] if command == "release-lock" => release_lock(path, device, inode, token),
        [_, command, path, device, inode] if command == "remove-tree" => remove_tree(path, device, inode),
        _ => Err("invalid arguments".to_string()),
    };
    if let Err(message) = result {
        eprintln!("{}", message);
        std::process::exit(1);
    }
}
