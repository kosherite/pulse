import SwiftUI

// MARK: - Pulse visual foundation
//
// These tokens describe the visual treatment used by Pulse's existing views. They deliberately
// contain no navigation, state, or domain semantics: screens keep their current hierarchy and data
// bindings, while cards, gauges, typography, and chrome share one maintainable source of truth.

public enum PulseVisualStyle {
    // Neutral, low-chroma surfaces sampled from the supplied dark-mode reference.
    public static var canvas: Color { PulseTheme.canvas }
    public static var surface: Color { PulseTheme.surface }
    public static var surfaceTop: Color { PulseTheme.surface }
    public static var surfaceBottom: Color { PulseTheme.surface }
    public static var inset: Color { PulseTheme.inset }

    public static var border: Color { PulseTheme.line }
    public static var borderHighlight: Color { PulseTheme.line }
    public static var divider: Color { PulseTheme.line }

    public static var primaryText: Color { PulseTheme.ink }
    public static var secondaryText: Color { PulseTheme.sub }
    public static var tertiaryText: Color { PulseTheme.ter }

    public static var mint: Color { PulseTheme.charge }
    public static var mintDeep: Color { PulseTheme.deep(PulseTheme.spec.charge) }
    public static var mintGlow: Color { PulseTheme.bright(PulseTheme.spec.charge) }

    public static let cardRadius: CGFloat = 24
    public static let compactRadius: CGFloat = 16
    public static let pillRadius: CGFloat = 999
    public static let pagePadding: CGFloat = 16
    public static let cardPadding: CGFloat = 20
    public static let itemGap: CGFloat = 12
    public static let sectionGap: CGFloat = 24
}

/// Shared card/panel treatment: a solid surface on iOS, gradient and soft elevation elsewhere.
/// `tint` is intentionally faint so metric identity never turns the whole card into a coloured tile.
public struct PulsePanelSurface: View {
    public var tint: Color?
    public var cornerRadius: CGFloat
    public var elevated: Bool
    public var surfaceOpacity: Double
    #if !os(iOS)
    @Environment(\.colorScheme) private var scheme
    #endif

    public init(
        tint: Color? = nil,
        cornerRadius: CGFloat = PulseVisualStyle.cardRadius,
        elevated: Bool = false,
        surfaceOpacity: Double = 1
    ) {
        self.tint = tint
        self.cornerRadius = cornerRadius
        self.elevated = elevated
        self.surfaceOpacity = surfaceOpacity
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        #if os(iOS)
        // Scrolling stacks contain many panels. Layered translucent gradients and blurred shadows
        // multiply their compositing work, so iOS uses one theme-aware fill and a thin tinted rim.
        // This changes decorative depth only; card geometry and the design-system colors stay the same.
        shape
            .fill(PulseVisualStyle.surface.opacity(PulseTheme.surfaceOpacity))
            .overlay {
                if let stroke = PulseTheme.cardStroke { shape.strokeBorder(stroke, lineWidth: 1) }
            }
            .shadow(color: PulseTheme.hasShadow ? Color.black.opacity(0.07) : .clear,
                    radius: PulseTheme.hasShadow ? 12 : 0, x: 0, y: PulseTheme.hasShadow ? 4 : 0)
            .opacity(surfaceOpacity)
        #else
        shape
            .fill(
                LinearGradient(
                    colors: [PulseVisualStyle.surfaceTop, PulseVisualStyle.surfaceBottom],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .overlay {
                if let tint {
                    shape.fill(
                        LinearGradient(
                            colors: [tint.opacity(0.055), tint.opacity(0.012), .clear],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                }
            }
            .overlay(
                shape.strokeBorder(
                    LinearGradient(
                        colors: [PulseVisualStyle.borderHighlight.opacity(0.72), PulseVisualStyle.border.opacity(0.52)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 0.8
                )
            )
            .shadow(
                color: scheme == .dark ? .black.opacity(elevated ? 0.34 : 0.18) : .black.opacity(0.10),
                radius: elevated ? 18 : 9,
                x: 0,
                y: elevated ? 10 : 5
            )
            .opacity(surfaceOpacity)
        #endif
    }
}

/// Shared edge-to-edge chrome for sheet and split-view headers. Unlike a card it has no
/// rounded outline or elevation, but it uses the same top-lit surface ramp and divider token.
public struct PulseChromeSurface: View {
    public init() {}

    public var body: some View {
        LinearGradient(
            colors: [PulseVisualStyle.surfaceTop, PulseVisualStyle.surfaceBottom],
            startPoint: .top,
            endPoint: .bottom
        )
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(PulseVisualStyle.divider)
                .frame(height: 0.5)
        }
    }
}

public extension View {
    func pulsePanel(
        tint: Color? = nil,
        cornerRadius: CGFloat = PulseVisualStyle.cardRadius,
        elevated: Bool = false,
        surfaceOpacity: Double = 1
    ) -> some View {
        background {
            PulsePanelSurface(
                tint: tint,
                cornerRadius: cornerRadius,
                elevated: elevated,
                surfaceOpacity: surfaceOpacity
            )
        }
    }
}
