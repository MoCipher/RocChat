import SwiftUI

/// RocChat — Splash / Loading Screen
///
/// Shown while the app initialises. Matches the web splash:
/// warm charcoal background, Roc bird icon with pulsing security rings,
/// gold title, turquoise subtitle, and a spinning loader.
struct SplashView: View {
    @State private var ringScale: CGFloat = 1.0
    @State private var ringOpacity: Double = 0.6
    @State private var birdOffset: CGFloat = 0
    @State private var spinAngle: Double = 0

    var body: some View {
        ZStack {
            // Background — warm charcoal gradient
            LinearGradient(
                gradient: Gradient(colors: [
                    Color(red: 0.102, green: 0.078, blue: 0.063),   // #1A1410
                    Color(red: 0.059, green: 0.051, blue: 0.039),   // #0F0D0A
                    Color(red: 0.082, green: 0.071, blue: 0.063),   // #151210
                ]),
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            VStack(spacing: 16) {
                Spacer()

                // Bird icon with security rings
                ZStack {
                    // Ring 3 (outermost)
                    Circle()
                        .stroke(Color(red: 0.831, green: 0.686, blue: 0.216).opacity(0.06), lineWidth: 1.5)
                        .frame(width: 170, height: 170)
                        .scaleEffect(ringScale)
                        .opacity(ringOpacity * 0.5)

                    // Ring 2
                    Circle()
                        .stroke(Color(red: 0.831, green: 0.686, blue: 0.216).opacity(0.12), lineWidth: 1.5)
                        .frame(width: 140, height: 140)
                        .scaleEffect(ringScale)
                        .opacity(ringOpacity * 0.75)

                    // Ring 1 (innermost)
                    Circle()
                        .stroke(Color(red: 0.831, green: 0.686, blue: 0.216).opacity(0.2), lineWidth: 1.5)
                        .frame(width: 110, height: 110)
                        .scaleEffect(ringScale)
                        .opacity(ringOpacity)

                    // App icon
                    Image("AppIcon")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 80, height: 80)
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                }
                .offset(y: birdOffset)

                // Title
                Text("RocChat")
                    .font(.system(size: 28, weight: .bold, design: .default))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [
                                Color(red: 0.984, green: 0.749, blue: 0.141),  // #fbbf24
                                Color(red: 0.831, green: 0.686, blue: 0.216),  // #D4AF37
                                Color(red: 0.706, green: 0.263, blue: 0.035),  // #b45309
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                // Subtitle
                Text("End-to-end encrypted")
                    .font(.system(size: 13, weight: .regular, design: .monospaced))
                    .foregroundColor(Color(red: 0.251, green: 0.878, blue: 0.816))  // #40E0D0

                // Spinner
                Circle()
                    .trim(from: 0.0, to: 0.7)
                    .stroke(
                        Color(red: 0.831, green: 0.686, blue: 0.216),
                        style: StrokeStyle(lineWidth: 2, lineCap: .round)
                    )
                    .frame(width: 24, height: 24)
                    .rotationEffect(.degrees(spinAngle))
                    .padding(.top, 16)

                Spacer()
            }
        }
        .onAppear {
            // Ring pulse animation
            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                ringScale = 1.08
                ringOpacity = 1.0
            }
            // Bird float
            withAnimation(.easeInOut(duration: 3).repeatForever(autoreverses: true)) {
                birdOffset = -8
            }
            // Spinner
            withAnimation(.linear(duration: 0.8).repeatForever(autoreverses: false)) {
                spinAngle = 360
            }
        }
    }
}

#Preview {
    SplashView()
}
