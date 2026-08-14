import Foundation

public enum IslandPresentationState: Equatable, Sendable {
    case dormant
    case revealed
    case expanded
}

public enum IslandPresentationAction: Equatable, Sendable {
    case toggle
    case pointerEntered
    case pointerExited
    case expand
    case collapse
    case escape
    case outsideClick
}

public enum IslandPresentationReducer {
    public static func reduce(
        _ state: IslandPresentationState,
        action: IslandPresentationAction
    ) -> IslandPresentationState {
        switch action {
        case .toggle:
            return state == .expanded ? .dormant : .expanded
        case .pointerEntered:
            return state == .dormant ? .revealed : state
        case .pointerExited:
            return state == .revealed ? .dormant : state
        case .expand:
            return .expanded
        case .collapse, .escape, .outsideClick:
            return .dormant
        }
    }
}
