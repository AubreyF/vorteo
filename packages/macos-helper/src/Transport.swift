import Foundation
import Security
import CryptoKit
import Darwin

#if PREVIEW
let runtime = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/vorteo-macos-helper-preview")
#else
let runtime = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/vorteo-macos-helper")
#endif
let socketPath = runtime.appendingPathComponent("helper.sock").path
struct Configuration: Codable {
    let token: String
    let clientRequirement: String
    let helperRequirement: String
}
struct Request: Codable {
    let token: String
    let operation: String
    var protocolVersion: Int = 2
    var parameters: BrowserParameters? = nil
}
func decodeRequest(_ data: Data) throws -> Request {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys).isSubset(of: ["token", "operation", "protocolVersion", "parameters"]) else { throw HelperError.invalid("invalid_request") }
    let request = try JSONDecoder().decode(Request.self, from: data)
    let fields: [String: Set<String>] = [
        "safari.read": ["windowId", "tabIndex"], "safari.select": ["windowId", "tabIndex"],
        "safari.navigate": ["windowId", "tabIndex", "destination"],
        "safari.click": ["windowId", "tabIndex", "pageId", "element"],
        "safari.fill": ["windowId", "tabIndex", "pageId", "element", "value"],
        "safari.choose": ["windowId", "tabIndex", "pageId", "element", "value"]
    ]
    let parameters = object["parameters"] as? [String: Any] ?? [:]
    guard Set(parameters.keys) == (fields[request.operation] ?? []) else { throw HelperError.invalid("invalid_request") }
    return request
}
struct Reply: Codable {
    let ok: Bool
    let code: String
    var windows: Int? = nil
    var tabs: Int? = nil
    var protocolVersion: Int? = 2
    var data: String? = nil
}
enum HelperError: Error { case invalid(String) }

func privatePath(_ path: String, directory: Bool) throws {
    var info = stat()
    guard lstat(path, &info) == 0, info.st_uid == getuid(),
          info.st_mode & 0o777 == (directory ? 0o700 : 0o600),
          info.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG) else {
        throw HelperError.invalid("unsafe_private_path")
    }
}
func configuration() throws -> Configuration {
    try privatePath(runtime.path, directory: true)
    let path = runtime.appendingPathComponent("config.json").path
    try privatePath(path, directory: false)
    let config = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    guard config.token.utf8.count == 64 else { throw HelperError.invalid("invalid_configuration") }
    return config
}
func address<T>(_ body: (UnsafePointer<sockaddr>, socklen_t) throws -> T) throws -> T {
    var value = sockaddr_un()
    value.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketPath.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: value.sun_path) else {
        throw HelperError.invalid("socket_path_too_long")
    }
    withUnsafeMutableBytes(of: &value.sun_path) { $0.copyBytes(from: bytes) }
    value.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let length = socklen_t(value.sun_len)
    return try withUnsafePointer(to: &value) {
        try $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { try body($0, length) }
    }
}
func makeSocket() throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw HelperError.invalid("socket_failed") }
    var timeout = timeval(tv_sec: 35, tv_usec: 0)
    var noSignal: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    return fd
}
// Audit tokens bind signature validation to this connection's process incarnation.
// PID-only validation can race with process exit and PID reuse.
func authorizedPeer(_ fd: Int32, requirement: String) -> Bool {
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { return false }
    var token = audit_token_t()
    var length = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0 else { return false }
    let audit = withUnsafeBytes(of: &token) { Data($0) }
    var code: SecCode?
    var rule: SecRequirement?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: audit] as CFDictionary, [], &code) == errSecSuccess,
          SecRequirementCreateWithString(requirement as CFString, [], &rule) == errSecSuccess,
          let code, let rule else { return false }
    return SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), rule) == errSecSuccess
}
func sameToken(_ lhs: String, _ rhs: String) -> Bool {
    let a = Array(SHA256.hash(data: Data(lhs.utf8)))
    let b = Array(SHA256.hash(data: Data(rhs.utf8)))
    return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
}
func readFrame(_ fd: Int32, limit: Int = 16384) throws -> Data {
    var frame = Data()
    var byte: UInt8 = 0
    // One bounded request per connection. Timeout prevents idle clients holding it forever.
    while frame.count < limit {
        guard recv(fd, &byte, 1, 0) == 1 else { throw HelperError.invalid("incomplete_frame") }
        if byte == 10 { return frame }
        frame.append(byte)
    }
    throw HelperError.invalid("frame_too_large")
}
func writeFrame<T: Encodable>(_ value: T, _ fd: Int32) throws {
    var bytes = try JSONEncoder().encode(value)
    bytes.append(10)
    try bytes.withUnsafeBytes { buffer in
        var offset = 0
        while offset < buffer.count {
            let sent = send(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset, 0)
            guard sent > 0 else { throw HelperError.invalid("write_failed") }
            offset += sent
        }
    }
}
