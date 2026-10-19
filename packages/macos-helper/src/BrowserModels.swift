import Foundation

struct BrowserTab: Codable, Equatable { let windowId: Int; let tabIndex: Int }
struct BrowserDestination: Codable { let id: String; let url: String }
struct BrowserPolicy: Codable {
    let allowedOrigins: [String]
    let tabs: [BrowserTab]
    let destinations: [BrowserDestination]
    let allowedText: [String]
    let actions: [String]
}
struct BrowserParameters: Codable {
    var windowId: Int? = nil
    var tabIndex: Int? = nil
    var pageId: String? = nil
    var element: String? = nil
    var destination: String? = nil
    var value: String? = nil
}

struct BrowserElement: Codable {
    let handle: String
    let tag: String
    let type: String
    var label: String
    let disabled: Bool
    let checked: Bool
    var options: [String]
}
struct BrowserSnapshot: Codable {
    let origin: String
    let pageId: String
    let readyState: String
    var headings: [String]
    var elements: [BrowserElement]
}
