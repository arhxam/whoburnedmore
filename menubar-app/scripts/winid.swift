// Print the CGWindowID of a BurnBar window (default title "BurnBar Debug",
// override with argv[1]) — for `screencapture -l`.
import CoreGraphics
import Foundation

let wanted = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "BurnBar Debug"
if let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] {
    for w in list
    where (w["kCGWindowOwnerName"] as? String) == "BurnBar"
        && (w["kCGWindowName"] as? String) == wanted {
        if let id = w["kCGWindowNumber"] as? Int {
            print(id)
            exit(0)
        }
    }
}
exit(1)
