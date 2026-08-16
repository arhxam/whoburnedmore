import Foundation

/// Keep idle hover discovery responsive without waking the main thread at an
/// animation-frame cadence. Active reveal interactions retain precise sampling;
/// the expanded panel is handled entirely by event monitors.
public enum PointerSamplingPolicy {
    public static func interval(for state: IslandPresentationState) -> TimeInterval? {
        switch state {
        case .dormant: return 0.2
        case .revealed: return 0.03
        case .expanded: return nil
        }
    }
}
