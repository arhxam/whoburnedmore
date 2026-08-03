import SwiftUI

/// Pure-SwiftUI controls for the Settings window. Two reasons over stock:
/// they match BurnBar's look (orange accent), and they render correctly in
/// ImageRenderer (NSControl-backed Toggle/Picker draw as placeholders there).

struct CheckToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: configuration.isOn ? "checkmark.square.fill" : "square")
                    .font(.system(size: 14))
                    .foregroundStyle(configuration.isOn ? Color.orange : Color.secondary)
                configuration.label
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Horizontal pill selector — replacement for small Pickers.
struct PillPicker<T: Hashable>: View {
    let options: [(value: T, label: String)]
    @Binding var selection: T

    var body: some View {
        HStack(spacing: 6) {
            ForEach(options, id: \.value) { option in
                Button {
                    selection = option.value
                } label: {
                    Text(option.label)
                        .font(.caption)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            selection == option.value
                                ? AnyShapeStyle(Color.orange.opacity(0.25))
                                : AnyShapeStyle(.quaternary.opacity(0.5)),
                            in: Capsule()
                        )
                        .overlay(
                            Capsule().strokeBorder(
                                selection == option.value ? Color.orange : .clear, lineWidth: 1
                            )
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Vertical radio list — replacement for the radioGroup Picker.
struct RadioList<T: Hashable>: View {
    let options: [(value: T, label: String)]
    @Binding var selection: T

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(options, id: \.value) { option in
                Button {
                    selection = option.value
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: selection == option.value ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(selection == option.value ? Color.orange : Color.secondary)
                        Text(option.label)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}
