import SwiftUI

struct AuthView: View {
    @EnvironmentObject var authVM: AuthViewModel
    @State private var isRegistering = false
    @State private var username = ""
    @State private var displayName = ""
    @State private var passphrase = ""
    @State private var passphraseConfirm = ""
    
    var body: some View {
        ZStack {
            Color.midnightAzure.ignoresSafeArea()
            
            VStack(spacing: 24) {
                // Roc bird logo - golden gradient circle with bird
                ZStack {
                    Circle()
                        .fill(
                            RadialGradient(
                                gradient: Gradient(colors: [
                                    .rocGold.opacity(0.2),
                                    .clear
                                ]),
                                center: .center,
                                startRadius: 0,
                                endRadius: 60
                            )
                        )
                        .frame(width: 120, height: 120)

                    Image(systemName: "bird.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(
                            LinearGradient(
                                colors: [.rocGoldLight, .rocGold, .rocGoldDark],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .shadow(color: .rocGold.opacity(0.3), radius: 8, y: 4)
                }
                
                VStack(spacing: 6) {
                    Text("RocChat")
                        .font(.custom("Montserrat", size: 32).bold())
                        .foregroundStyle(
                            LinearGradient(
                                colors: [Color(hex: "fbbf24"), .rocGold, Color(hex: "b45309")],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                    
                    Text("End-to-end encrypted")
                        .font(.custom("JetBrains Mono", size: 12))
                        .foregroundColor(.turquoise)
                        .tracking(1)
                }
                
                VStack(spacing: 16) {
                    TextField("Username", text: $username)
                        .textFieldStyle(RocTextFieldStyle())
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                    
                    if isRegistering {
                        TextField("Display Name", text: $displayName)
                            .textFieldStyle(RocTextFieldStyle())
                    }
                    
                    SecureField("Passphrase", text: $passphrase)
                        .textFieldStyle(RocTextFieldStyle())
                    
                    if isRegistering {
                        SecureField("Confirm Passphrase", text: $passphraseConfirm)
                            .textFieldStyle(RocTextFieldStyle())
                    }
                    
                    if let error = authVM.errorMessage {
                        Text(error)
                            .font(.caption)
                            .foregroundColor(.danger)
                    }
                    
                    Button(action: submit) {
                        HStack {
                            if authVM.isLoading {
                                ProgressView()
                                    .tint(Color.midnightAzure)
                            }
                            Text(isRegistering ? "Create Account" : "Sign In")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color.rocGold)
                        .foregroundColor(.midnightAzure)
                        .cornerRadius(8)
                    }
                    .disabled(authVM.isLoading)
                    
                    Button(isRegistering ? "Already have an account? Sign in" : "New to RocChat? Create account") {
                        withAnimation { isRegistering.toggle() }
                    }
                    .font(.subheadline)
                    .foregroundColor(.rocGold)
                }
                .padding(32)
                .background(Color.bgCard)
                .cornerRadius(16)
                .shadow(color: .black.opacity(0.3), radius: 24, y: 8)
            }
            .padding(24)
        }
        .sheet(item: Binding(
            get: { authVM.recoveryPhrase.map { RecoveryPhraseWrapper(words: $0) } },
            set: { _ in }
        )) { wrapper in
            RecoveryPhraseSheet(words: wrapper.words) {
                authVM.dismissRecoveryPhrase()
            }
            .interactiveDismissDisabled()
        }
        .sheet(isPresented: $authVM.showImportWizard) {
            OnboardingImportSheet {
                authVM.dismissImportWizard()
            }
            .interactiveDismissDisabled()
        }
    }
    
    private func submit() {
        if isRegistering {
            authVM.register(
                username: username,
                displayName: displayName,
                passphrase: passphrase,
                passphraseConfirm: passphraseConfirm
            )
        } else {
            authVM.login(username: username, passphrase: passphrase)
        }
    }
}

struct RocTextFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .padding(12)
            .background(Color.bgCard)
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color(hex: "D6CEBC"), lineWidth: 1)
            )
            .foregroundColor(.textPrimary)
    }
}

#Preview {
    AuthView()
        .environmentObject(AuthViewModel())
}

// MARK: - Recovery Phrase

struct RecoveryPhraseWrapper: Identifiable {
    let id = UUID()
    let words: [String]
}

struct RecoveryPhraseSheet: View {
    let words: [String]
    let onContinue: () -> Void
    @State private var acknowledged = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 32))
                        .foregroundColor(.orange)

                    Text("Recovery Phrase")
                        .font(.title2.bold())
                        .foregroundColor(.rocGold)

                    Text("Write these 12 words down and store them in a safe place. This is your **only way** to recover your account if you lose access.")
                        .font(.subheadline)
                        .foregroundColor(.orange)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)

                    // Word grid - 4 rows x 3 columns
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
                        ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                            HStack(spacing: 4) {
                                Text("\(index + 1)")
                                    .font(.caption2)
                                    .foregroundColor(.textSecondary)
                                    .frame(width: 16)
                                Text(word)
                                    .font(.system(.subheadline, design: .monospaced))
                                    .fontWeight(.medium)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .background(Color.midnightAzure.opacity(0.5))
                            .cornerRadius(8)
                        }
                    }
                    .padding(.horizontal)

                    HStack(spacing: 10) {
                        Image(systemName: acknowledged ? "checkmark.square.fill" : "square")
                            .foregroundColor(acknowledged ? .rocGold : .textSecondary)
                            .font(.title3)
                            .onTapGesture { acknowledged.toggle() }
                        Text("I have written down my recovery phrase")
                            .font(.subheadline)
                            .onTapGesture { acknowledged.toggle() }
                    }
                    .padding(.horizontal)

                    Button(action: onContinue) {
                        Text("Continue")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(acknowledged ? Color.rocGold : Color.gray)
                            .foregroundColor(.midnightAzure)
                            .cornerRadius(8)
                    }
                    .disabled(!acknowledged)
                    .padding(.horizontal)
                }
                .padding(.vertical, 24)
            }
            .background(Color.bgCard)
        }
    }
}
