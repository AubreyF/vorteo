import Foundation
import AppKit
import Carbon

func origin(_ value: String) -> String? {
    guard let url = URLComponents(string: value), url.scheme == "https",
          let host = url.host, url.user == nil, url.password == nil,
          url.port == nil || url.port == 443 else { return nil }
    return "https://\(host.lowercased())"
}
func browserPolicy() throws -> BrowserPolicy {
    let path = runtime.appendingPathComponent("browser-policy.json").path
    try privatePath(path, directory: false)
    let policy = try JSONDecoder().decode(BrowserPolicy.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    guard !policy.allowedOrigins.isEmpty, policy.allowedOrigins.count <= 16,
          policy.allowedOrigins.allSatisfy({ origin($0) == $0 }),
          policy.tabs.count <= 16, policy.tabs.allSatisfy({ $0.windowId > 0 && $0.tabIndex > 0 }),
          policy.destinations.count <= 32, Set(policy.destinations.map(\.id)).count == policy.destinations.count,
          policy.destinations.allSatisfy({ !$0.id.isEmpty && $0.id.count <= 80 && policy.allowedOrigins.contains(origin($0.url) ?? "") }),
          policy.allowedText.count <= 200, policy.allowedText.allSatisfy({ !$0.isEmpty && $0.count <= 160 }),
          policy.actions.allSatisfy({ ["read", "select", "navigate", "click", "fill", "choose"].contains($0) }) else {
        throw HelperError.invalid("invalid_browser_policy")
    }
    return policy
}
// A compiled handler receives descriptors. Neither script source nor JavaScript
// is accepted from IPC. Numeric tab selectors and URL strings remain data.
func safariHandler(_ name: String, arguments: [NSAppleEventDescriptor]) throws -> NSAppleEventDescriptor {
    let source = """
    on listTabs()
        set rows to {}
        tell application id "com.apple.Safari"
            repeat with w in windows
                repeat with i from 1 to count of tabs of w
                    set end of rows to {id of w, i, URL of tab i of w}
                end repeat
            end repeat
        end tell
        return rows
    end listTabs
    on tabURL(w, i)
        tell application id "com.apple.Safari" to return URL of tab i of window id w
    end tabURL
    on selectTab(w, i, expectedURL)
        tell application id "com.apple.Safari"
            if URL of tab i of window id w is not expectedURL then error number -1700
            set current tab of window id w to tab i of window id w
            set index of window id w to 1
            activate
        end tell
        return "selected"
    end selectTab
    on pageOperation(w, i, expectedURL, sourceCode)
        with timeout of 10 seconds
            tell application id "com.apple.Safari"
                if URL of tab i of window id w is not expectedURL then error number -1700
                return do JavaScript sourceCode in tab i of window id w
            end tell
        end timeout
    end pageOperation
    """
    guard let script = NSAppleScript(source: source) else { throw HelperError.invalid("script_compile_failed") }
    let args = NSAppleEventDescriptor.list()
    for (index, argument) in arguments.enumerated() { args.insert(argument, at: index + 1) }
    let event = NSAppleEventDescriptor(eventClass: AEEventClass(kASAppleScriptSuite), eventID: AEEventID(kASSubroutineEvent), targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    event.setParam(NSAppleEventDescriptor(string: name), forKeyword: AEKeyword(keyASSubroutineName))
    event.setParam(args, forKeyword: AEKeyword(keyDirectObject))
    var error: NSDictionary?
    let reply = script.executeAppleEvent(event, error: &error)
    if let error {
        let message = error[NSAppleScript.errorMessage] as? String ?? ""
        if message.localizedCaseInsensitiveContains("JavaScript from Apple Events") {
            throw HelperError.invalid("safari_javascript_consent_required")
        }
        let number = error[NSAppleScript.errorNumber] as? Int ?? 0
        throw HelperError.invalid("apple_event_\(number)")
    }
    return reply
}
func browserOperation(_ request: Request) -> Reply {
    do {
        guard ["safari.discover", "safari.read", "safari.select", "safari.navigate", "safari.click", "safari.fill", "safari.choose"].contains(request.operation) else { throw HelperError.invalid("unsupported_operation") }
        let policy = try browserPolicy()
        if request.operation == "safari.discover" {
            guard safariPermission(prompt: false) == noErr else { return Reply(ok: false, code: "safari_consent_required") }
            let rows = try safariHandler("listTabs", arguments: [])
            var tabs: [[String: Any]] = []
            for index in 0..<rows.numberOfItems {
                guard let row = rows.atIndex(index + 1), let url = row.atIndex(3)?.stringValue,
                      let currentOrigin = origin(url), policy.allowedOrigins.contains(currentOrigin),
                      let window = row.atIndex(1), let tab = row.atIndex(2),
                      window.int32Value > 0, tab.int32Value > 0 else { continue }
                tabs.append(["windowId": Int(window.int32Value), "tabIndex": Int(tab.int32Value), "origin": currentOrigin])
                if tabs.count == 80 { break }
            }
            return Reply(ok: true, code: "tab_discovery", data: String(data: try JSONSerialization.data(withJSONObject: tabs), encoding: .utf8))
        }
        guard let parameters = request.parameters, let w = parameters.windowId, let i = parameters.tabIndex,
              w > 0, w <= Int(Int32.max), i > 0, i <= 10000,
              policy.tabs.contains(BrowserTab(windowId: w, tabIndex: i)) else { throw HelperError.invalid("tab_rejected") }
        let action = String(request.operation.dropFirst("safari.".count))
        guard policy.actions.contains(action) else { throw HelperError.invalid("browser_action_rejected") }
        guard safariPermission(prompt: false) == noErr else { return Reply(ok: false, code: "safari_consent_required") }
        let selectors = [NSAppleEventDescriptor(int32: Int32(w)), NSAppleEventDescriptor(int32: Int32(i))]
        let currentURL = try safariHandler("tabURL", arguments: selectors).stringValue ?? ""
        guard let currentOrigin = origin(currentURL), policy.allowedOrigins.contains(currentOrigin) else { throw HelperError.invalid("origin_rejected") }
        if action == "select" {
            _ = try safariHandler("selectTab", arguments: selectors + [NSAppleEventDescriptor(string: currentURL)])
            return Reply(ok: true, code: "tab_selected")
        }
        var payload: [String: Any] = ["action": action, "origin": currentOrigin, "allowedText": policy.allowedText, "destinations": policy.destinations.map(\.url)]
        if action == "read" { payload["pageId"] = UUID().uuidString }
        else if action == "navigate" {
            guard let destination = policy.destinations.first(where: { $0.id == parameters.destination }) else { throw HelperError.invalid("destination_rejected") }
            payload["destination"] = destination.url
            payload["destinationOrigin"] = origin(destination.url)!
        } else {
            guard let pageId = parameters.pageId, UUID(uuidString: pageId) != nil,
                  let element = parameters.element, element.range(of: "^e[0-9]{1,2}$", options: .regularExpression) != nil else { throw HelperError.invalid("element_rejected") }
            payload["pageId"] = pageId
            payload["element"] = element
            if action == "fill" || action == "choose" {
                guard let value = parameters.value, value.utf8.count <= 4096 else { throw HelperError.invalid("value_rejected") }
                payload["value"] = value
            }
        }
        guard let resource = Bundle.main.url(forResource: "page", withExtension: "js", subdirectory: "browser") else { throw HelperError.invalid("browser_resource_missing") }
        let program = try String(contentsOf: resource, encoding: .utf8)
        let json = String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
        let source = program + "\nvorteoPage(" + json + ");"
        let answer = try safariHandler("pageOperation", arguments: selectors + [NSAppleEventDescriptor(string: currentURL), NSAppleEventDescriptor(string: source)]).stringValue ?? ""
        guard answer.utf8.count <= 24000, let data = answer.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ok = object["ok"] as? Bool, let code = object["code"] as? String,
              ["page_snapshot", "navigation_started", "interaction_completed", "origin_changed", "frames_not_supported", "destination_rejected", "stale_page", "stale_element", "element_action_rejected", "unsupported_operation"].contains(code) else { throw HelperError.invalid("invalid_page_reply") }
        if code != "page_snapshot" { return Reply(ok: ok, code: code) }
        guard ok, let snapshotData = answer.data(using: .utf8) else { throw HelperError.invalid("invalid_page_reply") }
        var snapshot = try JSONDecoder().decode(BrowserSnapshot.self, from: snapshotData)
        guard snapshot.origin == currentOrigin, snapshot.pageId == payload["pageId"] as? String,
              ["loading", "interactive", "complete"].contains(snapshot.readyState),
              snapshot.headings.count <= 20, snapshot.elements.count <= 80 else { throw HelperError.invalid("invalid_page_reply") }
        snapshot.headings = snapshot.headings.map { policy.allowedText.contains($0) ? $0 : "[withheld]" }
        for index in snapshot.elements.indices {
            let element = snapshot.elements[index]
            guard element.handle == "e\(index)", ["button", "a", "input", "textarea", "select", "div", "span"].contains(element.tag),
                  ["text", "email", "password", "url", "search", "checkbox", "radio", "submit", "button", "textarea", "select", "a", "other"].contains(element.type) else { throw HelperError.invalid("invalid_page_reply") }
            if !policy.allowedText.contains(element.label) { snapshot.elements[index].label = "[withheld]" }
            snapshot.elements[index].options = element.options.filter { policy.allowedText.contains($0) }.prefix(20).map { $0 }
        }
        return Reply(ok: true, code: code, data: String(data: try JSONEncoder().encode(snapshot), encoding: .utf8))
    } catch HelperError.invalid(let code) {
        return Reply(ok: false, code: code)
    } catch {
        return Reply(ok: false, code: "browser_policy_unavailable")
    }
}
