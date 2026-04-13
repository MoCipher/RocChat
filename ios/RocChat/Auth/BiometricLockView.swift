import SwiftUI

struct BiometricLockView: View {
    @EnvironmentObject var authVM: AuthViewModel
    
    var body: some View {
        ZStack {
            Color.midnightAzure.ignoresSafeArea()
            
            VStack(spacing: 24) {
                Image(systemName: biometricIcon)
                    .font(.system(size: 64))
                    .foregroundColor(.rocGold)
                
                Text("RocChat is Locked")
                    .font(.title2)
                    .fontWeight(.bold)
                    .foregroundColor(.white)
                
                Text("Use \(authVM.biometricType) to unlock")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                
                if let error = authVM.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                }
                
                Button(action: { authVM.authenticateWithBiometric() }) {
                    HStack {
                        Image(systemName: biometricIcon)
                        Text("Unlock")
                    }
                    .font(.headline)
                    .foregroundColor(.midnightAzure)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 12)
                    .background(Color.rocGold)
                    .cornerRadius(12)
                }
            }
            .padding()
        }
        .onAppear {
            authVM.authenticateWithBiometric()
        }
    }
    
    private var biometricIcon: String {
        switch authVM.biometricType {
        case "Face ID": return "faceid"
        case "Touch ID": return "touchid"
        case "Optic ID": return "opticid"
        default: return "lock.shield"
        }
    }
}
