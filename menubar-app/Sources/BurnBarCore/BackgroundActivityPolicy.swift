import Foundation

public enum PublishedValuePolicy {
    public static func shouldPublish<Value: Equatable>(
        current: Value?, incoming: Value
    ) -> Bool {
        current != incoming
    }
}
