import Foundation

// The client has no Automation entitlement and performs no Apple events.
// Its capability arrives over stdin, never argv or the process environment.
do {
    guard CommandLine.arguments.count == 2 else { throw HelperError.invalid("operation_required") }
    let config = try configuration()
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 16384 else { throw HelperError.invalid("request_too_large") }
    var request: Request
    if let token = String(data: input, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), token.count == 64 {
        request = Request(token: token, operation: CommandLine.arguments[1])
    } else {
        request = try decodeRequest(input)
        guard request.operation == CommandLine.arguments[1], request.token.count == 64 else { throw HelperError.invalid("invalid_request") }
    }
    let fd = try makeSocket()
    defer { close(fd) }
    guard try address({ connect(fd, $0, $1) }) == 0 else { throw HelperError.invalid("helper_unavailable") }
    guard authorizedPeer(fd, requirement: config.helperRequirement) else { throw HelperError.invalid("helper_rejected") }
    try writeFrame(request, fd)
    let reply = try JSONDecoder().decode(Reply.self, from: readFrame(fd, limit: 32768))
    guard reply.protocolVersion == 2 else { throw HelperError.invalid("protocol_mismatch") }
    try FileHandle.standardOutput.write(contentsOf: JSONEncoder().encode(reply) + Data([10]))
    exit(reply.ok ? 0 : 1)
} catch {
    // Do not include arbitrary decoded data or private configuration in diagnostics.
    let code: String
    if case HelperError.invalid(let reason) = error { code = reason } else { code = "client_failed" }
    try? FileHandle.standardOutput.write(contentsOf: JSONEncoder().encode(Reply(ok: false, code: code)) + Data([10]))
    exit(1)
}
