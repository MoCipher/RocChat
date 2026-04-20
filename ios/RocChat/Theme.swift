import SwiftUI

extension Color {
    static let rocGold       = Color(hex: "D4AF37")
    static let rocGoldLight  = Color(hex: "E8CC6E")
    static let rocGoldDark   = Color(hex: "A68B2A")
    static let desertSky     = Color(hex: "87CEEB")
    static let ancientIvory  = Color(hex: "F5F5DC")
    static let shadowBronze  = Color(hex: "8B7355")
    static let midnightAzure = Color(hex: "0D1117")
    static let turquoise     = Color(hex: "40E0D0")
    static let bubbleMine    = Color.rocGold.opacity(0.12)
    static let bubbleTheirs  = Color(hex: "FEFCF6")
    static let bgApp         = Color(hex: "F5F3ED")
    static let bgCard        = Color(hex: "FEFCF6")
    static let textPrimary   = Color(hex: "1A1A2E")
    static let textSecondary = Color(hex: "5C5A6E")
    static let success       = Color(hex: "1EA672")
    static let danger        = Color(hex: "DC3545")

    // Dark mode variants
    static let darkBgApp     = Color(hex: "151210")
    static let darkBgCard    = Color(hex: "1C1814")
    static let darkText      = Color(hex: "E8E2D4")
    static let darkTextSec   = Color(hex: "A09888")
    static let darkBubbleTheirs = Color(hex: "1C1814")

    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch hex.count {
        case 6:
            (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
        case 8:
            (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
        default:
            (a, r, g, b) = (255, 0, 0, 0)
        }
        self.init(
            .sRGB,
            red: Double(r) / 255,
            green: Double(g) / 255,
            blue: Double(b) / 255,
            opacity: Double(a) / 255
        )
    }
}

// MARK: - Adaptive Colors (Light/Dark)

extension Color {
    static func adaptive(light: Color, dark: Color) -> Color {
        Color(UIColor { traitCollection in
            traitCollection.userInterfaceStyle == .dark
                ? UIColor(dark)
                : UIColor(light)
        })
    }

    static let adaptiveBg = adaptive(light: bgApp, dark: darkBgApp)
    static let adaptiveCard = adaptive(light: bgCard, dark: darkBgCard)
    static let adaptiveText = adaptive(light: textPrimary, dark: darkText)
    static let adaptiveTextSec = adaptive(light: textSecondary, dark: darkTextSec)
    static let adaptiveBubbleTheirs = adaptive(light: bubbleTheirs, dark: darkBubbleTheirs)
}

// MARK: - FlowLayout (wrapping horizontal layout for tags/chips)
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth, height: y + rowHeight)
    }
    
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            sub.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
