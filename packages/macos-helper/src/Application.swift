import AppKit
import Carbon

func safariPermission(prompt: Bool) -> OSStatus {
    let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.Safari")
    return AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, prompt)
}
func performOperation(_ operation: String) -> Reply {
    switch operation {
    case "status":
        let permission = safariPermission(prompt: false)
        return Reply(ok: true, code: "safari_permission_\(permission)")
    case "safari.request-consent":
        #if PREVIEW
        return Reply(ok: false, code: "preview_consent_disabled")
        #else
        let permission = safariPermission(prompt: true)
        return Reply(ok: permission == noErr, code: "safari_permission_\(permission)")
        #endif
    case "safari.summary":
        guard safariPermission(prompt: false) == noErr else {
            return Reply(ok: false, code: "safari_consent_required")
        }
        // Static source only. Never interpolate caller input into AppleScript.
        let source = """
        with timeout of 10 seconds
            tell application id "com.apple.Safari"
                set tabCount to 0
                repeat with w in windows
                    set tabCount to tabCount + (count of tabs of w)
                end repeat
                return {count of windows, tabCount}
            end tell
        end timeout
        """
        var error: NSDictionary?
        guard let script = NSAppleScript(source: source) else { return Reply(ok: false, code: "script_compile_failed") }
        let result = script.executeAndReturnError(&error)
        if let error {
            let number = error[NSAppleScript.errorNumber] as? Int ?? 0
            return Reply(ok: false, code: "apple_event_\(number)")
        }
        guard result.numberOfItems == 2 else { return Reply(ok: false, code: "unexpected_safari_reply") }
        return Reply(ok: true, code: "safari_summary", windows: Int(result.atIndex(1)!.int32Value), tabs: Int(result.atIndex(2)!.int32Value))
    case "quit":
        return Reply(ok: true, code: "quitting")
    default:
        return Reply(ok: false, code: "unsupported_operation")
    }
}

final class Application: NSObject, NSApplicationDelegate {
    var item: NSStatusItem?
    var listener: Int32 = -1
    var ownsSocket = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let config = try configuration()
            listener = try makeSocket()
            // Bind fails if another instance or stale socket exists; never unlink a live endpoint.
            guard try address({ Darwin.bind(listener, $0, $1) }) == 0 else { throw HelperError.invalid("listener_failed") }
            ownsSocket = true
            guard chmod(socketPath, 0o600) == 0, listen(listener, 8) == 0 else {
                throw HelperError.invalid("listener_failed")
            }
            item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            #if PREVIEW
            item?.button?.title = "Vorteo Preview"
            #else
            item?.button?.title = "Vorteo"
            #endif
            let menu = NSMenu()
            #if !PREVIEW
            menu.addItem(NSMenuItem(title: "Allow Safari Automation", action: #selector(consent), keyEquivalent: ""))
            #endif
            menu.addItem(NSMenuItem(title: "Quit Permission Helper", action: #selector(quit), keyEquivalent: ""))
            for entry in menu.items { entry.target = self }
            item?.menu = menu
            DispatchQueue.global(qos: .utility).async { [self] in
                while true {
                    let fd = accept(listener, nil, nil)
                    if fd < 0 { break }
                    defer { close(fd) }
                    let response: Reply
                    var requestedQuit = false
                    do {
                        guard authorizedPeer(fd, requirement: config.clientRequirement) else {
                            try writeFrame(Reply(ok: false, code: "caller_rejected"), fd)
                            continue
                        }
                        let request = try decodeRequest(readFrame(fd))
                        guard sameToken(request.token, config.token) else {
                            try writeFrame(Reply(ok: false, code: "caller_rejected"), fd)
                            continue
                        }
                        requestedQuit = request.operation == "quit"
                        if request.protocolVersion != 2 { response = Reply(ok: false, code: "protocol_mismatch") }
                        else if request.operation.hasPrefix("safari.") && !["safari.summary", "safari.request-consent"].contains(request.operation) {
                            response = DispatchQueue.main.sync { browserOperation(request) }
                        } else { response = DispatchQueue.main.sync { performOperation(request.operation) } }
                    } catch {
                        response = Reply(ok: false, code: "invalid_request")
                    }
                    try? writeFrame(response, fd)
                    if requestedQuit && response.ok { DispatchQueue.main.async { NSApp.terminate(nil) } }
                }
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Vorteo permission helper could not start"
            alert.informativeText = "Check the private helper configuration and socket. Use the documented diagnostics before reinstalling."
            alert.runModal()
            NSApp.terminate(nil)
        }
    }
    func applicationWillTerminate(_ notification: Notification) {
        if listener >= 0 { close(listener) }
        if ownsSocket { unlink(socketPath) }
    }
    @objc func consent() {
        let reply = performOperation("safari.request-consent")
        let alert = NSAlert()
        alert.messageText = reply.ok ? "Safari Automation is allowed" : "Safari Automation was not granted"
        alert.informativeText = "\(reply.code). You can review Vorteo in System Settings > Privacy & Security > Automation."
        alert.runModal()
    }
    @objc func quit() { NSApp.terminate(nil) }
}
let app = NSApplication.shared
let delegate = Application()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
