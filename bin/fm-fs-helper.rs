use std::env;
use std::ffi::CString;
use std::io::{Read, Write};
use std::os::raw::{c_char, c_int};
use std::os::unix::io::RawFd;

#[repr(C)]
struct Stat {
    st_dev: u64, st_ino: u64, st_nlink: u64, st_mode: u32, st_uid: u32, st_gid: u32,
    st_rdev: u64, st_size: i64, st_blksize: i64, st_blocks: i64, st_atime: i64,
    st_atime_nsec: i64, st_mtime: i64, st_mtime_nsec: i64, st_ctime: i64,
    st_ctime_nsec: i64, __unused: [i64; 3],
}

extern "C" {
    fn close(fd: c_int) -> c_int;
    fn fstat(fd: c_int, stat: *mut Stat) -> c_int;
    fn open(path: *const c_char, flags: c_int) -> c_int;
    fn openat(fd: c_int, path: *const c_char, flags: c_int, mode: u32) -> c_int;
    fn ftruncate(fd: c_int, length: i64) -> c_int;
    fn flock(fd: c_int, operation: c_int) -> c_int;
    fn mkdirat(fd: c_int, path: *const c_char, mode: u32) -> c_int;
    fn geteuid() -> u32;
}

const O_RDONLY: c_int = 0;
const O_DIRECTORY: c_int = 0o200000;
const O_NOFOLLOW: c_int = 0o400000;
const O_RDWR: c_int = 0o2;
const O_CREAT: c_int = 0o100;
const LOCK_EX: c_int = 2;
const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;

fn cstring(value: &str) -> Result<CString, String> { CString::new(value).map_err(|_| "NUL in path".to_string()) }

fn stat_fd(fd: RawFd) -> Result<Stat, String> {
    let mut value = Stat { st_dev: 0, st_ino: 0, st_nlink: 0, st_mode: 0, st_uid: 0, st_gid: 0, st_rdev: 0, st_size: 0, st_blksize: 0, st_blocks: 0, st_atime: 0, st_atime_nsec: 0, st_mtime: 0, st_mtime_nsec: 0, st_ctime: 0, st_ctime_nsec: 0, __unused: [0; 3] };
    if unsafe { fstat(fd, &mut value) } != 0 { return Err("fstat failed".to_string()); }
    Ok(value)
}

fn owned_directory(fd: RawFd) -> Result<Stat, String> {
    let value = stat_fd(fd)?;
    if value.st_mode & S_IFMT != S_IFDIR || value.st_uid != unsafe { geteuid() } || value.st_mode & 0o077 != 0 { return Err("unsafe directory".to_string()); }
    Ok(value)
}

fn owned_file(fd: RawFd) -> Result<Stat, String> {
    let value = stat_fd(fd)?;
    if value.st_mode & S_IFMT != S_IFREG || value.st_uid != unsafe { geteuid() } || value.st_mode & 0o077 != 0 { return Err("unsafe file".to_string()); }
    Ok(value)
}

fn matches_identity(value: &Stat, device: &str, inode: &str) -> bool { value.st_dev.to_string() == device && value.st_ino.to_string() == inode }

fn open_directory(path: &str) -> Result<RawFd, String> {
    if !path.starts_with('/') { return Err("absolute path required".to_string()); }
    let root = cstring("/")?;
    let mut fd = unsafe { open(root.as_ptr(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW) };
    if fd < 0 { return Err("cannot open root".to_string()); }
    for component in path.split('/').filter(|part| !part.is_empty()) {
        if component == "." || component == ".." { unsafe { close(fd); } return Err("unsafe path".to_string()); }
        let component = cstring(component)?;
        let next = unsafe { openat(fd, component.as_ptr(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW, 0) };
        unsafe { close(fd); }
        if next < 0 { return Err("cannot open directory".to_string()); }
        fd = next;
    }
    owned_directory(fd)?;
    Ok(fd)
}

fn split_path(path: &str) -> Result<(&str, &str), String> {
    let value = std::path::Path::new(path);
    let parent = value.parent().and_then(|part| part.to_str()).ok_or_else(|| "invalid path".to_string())?;
    let name = value.file_name().and_then(|part| part.to_str()).ok_or_else(|| "invalid path".to_string())?;
    if name == "." || name == ".." { return Err("invalid path".to_string()); }
    Ok((parent, name))
}

fn open_child(parent: RawFd, name: &str, flags: c_int) -> Result<RawFd, String> {
    let name = cstring(name)?;
    let child = unsafe { openat(parent, name.as_ptr(), flags | O_NOFOLLOW, 0) };
    if child < 0 { return Err("cannot open child".to_string()); }
    Ok(child)
}

fn open_bound_parent(path: &str, parent_device: &str, parent_inode: &str) -> Result<(RawFd, String), String> {
    let (parent_path, name) = split_path(path)?;
    let parent = open_directory(parent_path)?;
    if !matches_identity(&owned_directory(parent)?, parent_device, parent_inode) { unsafe { close(parent); } return Err("parent identity changed".to_string()); }
    Ok((parent, name.to_string()))
}

fn hold_lock(path: &str, parent_device: &str, parent_inode: &str, token: &str) -> Result<(), String> {
    if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) { return Err("invalid token".to_string()); }
    let (parent, name) = open_bound_parent(path, parent_device, parent_inode)?;
    let result = (|| {
        let name_c = cstring(&name)?;
        unsafe { mkdirat(parent, name_c.as_ptr(), 0o700); }
        let lock = open_child(parent, &name, O_RDONLY | O_DIRECTORY)?;
        let result = (|| {
            owned_directory(lock)?;
            let owner_name = cstring("owner.json")?;
            let owner = unsafe { openat(lock, owner_name.as_ptr(), O_RDWR | O_CREAT | O_NOFOLLOW, 0o600) };
            if owner < 0 { return Err("cannot open lock owner".to_string()); }
            let result = (|| {
                owned_file(owner)?;
                if unsafe { flock(owner, LOCK_EX) } != 0 { return Err("cannot lock owner".to_string()); }
                if unsafe { ftruncate(owner, 0) } != 0 { return Err("cannot publish lock".to_string()); }
                writeln!(std::io::stdout(), "locked:{}", token).map_err(|_| "cannot publish lock".to_string())?;
                std::io::stdout().flush().map_err(|_| "cannot publish lock".to_string())?;
                let mut input = String::new();
                std::io::stdin().read_to_string(&mut input).map_err(|_| "cannot wait for lock release".to_string())?;
                Ok(())
            })();
            unsafe { close(owner); }
            result
        })();
        unsafe { close(lock); }
        result
    })();
    unsafe { close(parent); }
    result
}

fn remove_tree_fd(fd: RawFd) -> Result<(), String> {
    let entries = std::fs::read_dir(format!("/proc/self/fd/{}", fd)).map_err(|_| "cannot read directory".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "cannot read directory entry".to_string())?;
        let name = entry.file_name().into_string().map_err(|_| "invalid directory entry".to_string())?;
        let directory = open_child(fd, &name, O_RDONLY | O_DIRECTORY);
        match directory {
            Ok(child) => {
                let result = (|| { owned_directory(child)?; remove_tree_fd(child) })();
                unsafe { close(child); }
                result?;
            }
            Err(_) => {
                let child = open_child(fd, &name, O_RDWR)?;
                let result = (|| { owned_file(child)?; if unsafe { ftruncate(child, 0) } != 0 { return Err("cannot clear file".to_string()); } Ok(()) })();
                unsafe { close(child); }
                result?;
            }
        }
    }
    Ok(())
}

fn remove_tree(path: &str, parent_device: &str, parent_inode: &str, device: &str, inode: &str) -> Result<(), String> {
    let (parent, name) = open_bound_parent(path, parent_device, parent_inode)?;
    let result = (|| {
        let directory = open_child(parent, &name, O_RDONLY | O_DIRECTORY)?;
        let result = (|| {
            if !matches_identity(&owned_directory(directory)?, device, inode) { return Err("identity changed".to_string()); }
            remove_tree_fd(directory)
        })();
        unsafe { close(directory); }
        result
    })();
    unsafe { close(parent); }
    result
}

fn remove_file(path: &str, parent_device: &str, parent_inode: &str, device: &str, inode: &str) -> Result<(), String> {
    let (parent, name) = open_bound_parent(path, parent_device, parent_inode)?;
    let result = (|| {
        let file = open_child(parent, &name, O_RDWR)?;
        let result = (|| {
            if !matches_identity(&owned_file(file)?, device, inode) { return Err("identity changed".to_string()); }
            if unsafe { ftruncate(file, 0) } != 0 { return Err("cannot clear file".to_string()); }
            Ok(())
        })();
        unsafe { close(file); }
        result
    })();
    unsafe { close(parent); }
    result
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let result = match args.as_slice() {
        [_, command] if command == "probe" => Ok(()),
        [_, command, path, parent_device, parent_inode, token] if command == "hold-lock" => hold_lock(path, parent_device, parent_inode, token),
        [_, command, path, parent_device, parent_inode, device, inode] if command == "remove-tree" => remove_tree(path, parent_device, parent_inode, device, inode),
        [_, command, path, parent_device, parent_inode, device, inode] if command == "remove-file" => remove_file(path, parent_device, parent_inode, device, inode),
        _ => Err("invalid arguments".to_string()),
    };
    if let Err(message) = result { eprintln!("{}", message); std::process::exit(1); }
}
