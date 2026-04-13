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
